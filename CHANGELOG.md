# Changelog

All notable changes to this project are documented in this file. Version numbers align exactly with the versions published on npm for `lazy-watch`.

This project follows the Keep a Changelog format and adheres to Semantic Versioning.

## [Unreleased]

### Changed

- The npm tarball now ships `docs/` (the API reference), `EXAMPLES.md`,
  and `CHANGELOG.md` alongside the source, so a version bump can be
  understood from `node_modules` without a trip to GitHub. The bundle is
  unaffected (`files` only)

### Fixed

- `Utils.hasArrayMarker` threw a TypeError on `null` and other non-object
  input. It is a public helper for inspecting diff values, and `null` is
  the wire format's own deletion marker, so it now returns false for null,
  leaves, and real arrays instead of throwing
- The benchmark runner counted its own loop as work: ops/sec came from a
  wall-clock span around a loop that awaited every call, so a synchronous
  benchmark paid a microtask tick per iteration and the fastest plain-object
  baselines measured little but that overhead. Ops/sec now derives from the
  summed per-iteration timings, and only functions returning a promise are
  awaited
- The benchmark regression guard's read and write ratios compared proxy
  construction against a plain literal: both benchmarks created and
  disposed an instance on every iteration, so the plain baseline was
  little more than the runner's loop overhead and the ratio swung from 7x
  locally to 118x on a shared CI runner for identical code (the 6.2.0
  release's CI benchmark job failed on it). The benchmarks now read and
  write an instance created once, a thousand rounds per iteration with the
  write side flushing each batch, so the ratio measures the trap cost
  against a plain access. With honest baselines the ratios are large
  (~100x for a proxied read, ~500x for a proxied write), and all three
  limits are re-based ~10x above them (see `benchmark/regression-guard.js`).
  No library code changed

## [6.2.0] - 2026-09-02

The undo manager learns to live beside remote edits: a `record` option
keeps batches that are not the user's own out of history, and where such
a batch reshapes the state, the steps it would break are dropped instead
of truncating or overwriting what it put there. No wire-format change;
6.0.x and 6.1.x replicas interoperate.

### Added

- **Undo beside remote edits.** `createUndoManager` takes a `record`
  option, `(meta, diff) => boolean`, asked for every batch: return false
  for batches that are not the user's own edits, such as remote diffs
  applied with `patch(mirror, diff, { origin: 'remote' })`. A declined
  batch is not recorded as a step, which replaces the `LazyWatch.silent`
  workaround sync layers needed to keep teammates' edits out of Ctrl+Z —
  and, unlike a silent change, it still reaches the manager: where the
  batch changed the shape of the state (an array's length; a container
  created, deleted, or changed between array and object), every step whose
  diff or inverse touches that path is dropped from both stacks. Without
  this, undoing a field edit after a teammate appended an element applied
  the step's recorded `$length` and truncated the array, deleting the
  teammate's element. Steps on other paths survive; field-level remote
  writes leave history alone (last-writer-wins, as documented for inverse
  diffs). The fuzzer's bidi mode now runs undo/redo ops beside the
  concurrent peer through this option

## [6.1.0] - 2026-09-01

Batch metadata lands: `flush`, `patch`, and `overwrite` can tag the batch
they emit with an object such as `{ origin: 'remote' }` that listeners
receive as a third argument, which turns the bidirectional sync and manual
undo recipes into one line per direction with no guard flag. Array
properties are typed correctly as `ArrayPatch` in the definitions, listener
dispatch is linear, and the convergence fuzzer gained a bidirectional mode.
No wire-format change; 6.0.x replicas interoperate.

### Added

- **Batch metadata and origins.** `LazyWatch.flush(watched, meta)` tags
  the batch it emits, and `patch`/`overwrite` accept the same `meta` as a
  third argument: on a proxy target, pending changes emit first
  (untagged), then the applied changes emit synchronously as their own
  batch carrying the metadata, which every listener receives as a third
  argument (`undefined` for ordinary batches). By convention the object is
  `{ origin: ... }`. This replaces the `applyingRemote` flag-and-flush
  pattern the docs taught for bidirectional sync with one line per
  direction (`patch(mirror, diff, { origin: 'remote' })` and a listener
  that skips that origin), and the manual undo recipe loses its guard the
  same way. The undo manager tags its batches `{ origin: 'undo' }` and
  `{ origin: 'redo' }`. Metadata must be an object (TypeError otherwise),
  is ignored on plain targets, and never travels with the diff. The
  fuzzer's bidirectional mode now runs on this recipe

### Fixed

- **`Patch<T>` typed array properties as nullable arrays.** For
  `tags: string[]` a diff's `tags` was `(string | null | undefined)[]`,
  so index fragments (`{ 1: 'b', $length: 2 }`) and element fragments
  (`{ 0: { done: true } }`) failed to compile, while `diff.tags.length`
  compiled and was `undefined` at runtime (fragments carry `$length`).
  Array properties are now `ArrayPatch<E>`: a real array or an
  index-keyed fragment with `$length`/`$splice` markers; narrow with
  `Array.isArray`. A watched root array patches as `ArrayPatch` of its
  element type. `ArrayPatch`, `PatchValue`, and `SpliceOp` are exported
- Listener dispatch was quadratic in the listener count (a membership scan
  per listener per emit); registrations now carry a removal flag instead
- An `AbortSignal` passed to `on` kept the instance reachable for as long
  as the signal lived, even after the listener was removed or the instance
  disposed: the abort handler is now detached when the registration ends
- The publish workflow now runs the coverage thresholds and the
  bundle-size budget check before publishing, like the test workflow

### Changed

- The convergence fuzzer gained two coverage areas: a `bidi` mode in
  which two peers exchange diffs through inboxes with the documented echo
  guard (either side writing in a given step, both holding the same state
  after delivery), and undo-mode runs that coalesce steps and exercise
  `group()`/`checkpoint()`, driving the undo manager's step merging
  through `composeDiffs`. Neither found a defect

## [6.0.0] - 2026-09-01

**Breaking release: wire format and value rules.** Every array node in a
diff now carries `$length` — ancestors of a deeper change included — which
is what lets receivers tell an array fragment from a plain object that
replaced an array, so kind changes converge in both directions. `Date`,
`RegExp`, `bigint`, `symbol`, and function values are rejected from
watched state like `NaN` and the collection types already were. All
replicas must upgrade together: a 5.x fragment without the marker arriving
where this version holds an array is applied as a replacement, and diffs
persisted by 5.x (send buffers, stored undo histories) cannot be applied —
resync with `snapshot` + `overwrite`. Most of the fixes below were found by
the new convergence fuzzer, which now runs as part of `npm test`.

### Breaking

- **Every array node in a diff carries `$length`**, including nodes that
  only hold a deeper change: `{ todos: { 0: { done: true }, $length: 2 } }`
  where 5.0 emitted `{ todos: { 0: { done: true } } }`. The marker is what
  lets receivers tell an array fragment (merge) from a plain object that
  replaced an array (replace), so all replicas must upgrade together — a
  5.0 fragment without the marker arriving where this version holds an
  array is applied as a replacement
- **Kind changes converge in both directions.** A plain object assigned
  over an array (`state.list = {}`), or arriving in a diff without array
  markers where the receiver holds an array, now replaces the array; 5.0
  merged its keys into the array as junk properties on the sender and
  every mirror. A marked fragment arriving where the receiver holds a plain
  object now replaces the object with the revived array; 5.0 let the
  target shape win and merged into the object
- **`composeDiffs` refuses two more pairings** with the same TypeError:
  a plain object following an array (value or fragment), and an object
  written into a slot the older diff truncated away — both would merge
  into a receiver's stale value where the sequential path replaced it.
  Newer truncations drop older index writes beyond them, and an older
  truncation followed by growth now deletes the gap explicitly
- **Structural array ops are recorded per index while a listener is
  registered below the array** (the shape `{ inverse: true }` produces),
  so element listeners receive exact slot diffs with null markers; a
  compact `$splice` cannot say what moved into a slot. Listen on the array
  itself to keep compact ops. This replaces the interim "live value"
  delivery introduced earlier in this cycle
- **`Date` and `RegExp` are no longer accepted in watched state**, and
  neither are `bigint`, `symbol`, or function values — all rejected with a
  `TypeError` naming the path at every entry point (constructor,
  assignment, array methods, `patch`/`overwrite`/`composeDiffs`), like
  `NaN` and the collection types already were, and for the same reason:
  JSON cannot carry them faithfully. A `Date` arrived on mirrors as an ISO
  string, and in a bidirectional link the sender itself drifted to a
  string on the echo; a `RegExp` arrived as `{}`; `JSON.stringify` threw
  on `bigint` inside the listener; symbols and functions vanished — each a
  silent desync the "diffs are plain JSON" contract never allowed for.
  Store timestamps (`date.getTime()`) or ISO strings, regex source/flags,
  and numbers instead. `Utils.deepClone`/`deepEqual` still handle Date and
  RegExp as general-purpose helpers

### Added

- **Convergence fuzzer** (`test/fuzz/`): seeded random mutation sequences
  — nested writes, structural ops, `patch`/`overwrite` with perturbed
  snapshots and hand-built fragments, held handles, delete-and-recreate,
  throwing transactions, undo/redo — checked after every batch against a
  JSON-fed mirror, a relay of that mirror, a plain-object mirror, a
  `composeDiffs` buffer, inverse restore, nested-listener shadows, and the
  undo manager. A short fixed-seed pass runs in `npm test`; `npm run fuzz`
  runs a longer campaign and prints a reproduction command (with `--trace`
  for a batch-by-batch log) on failure. Every bug below marked *(fuzzer)*
  was found by it and is pinned in `test/suites/fuzz-regressions.test.js`
- `Utils.hasArrayMarker(value)` and `Utils.canMerge(target, source,
  wholesale)` expose the wire format's fragment test and the single
  merge-or-replace rule both appliers follow

### Fixed

- **Assigning an array and mutating it in the same batch corrupted state**
  *(fuzzer)*: the diff node for a wholesale array assignment WAS the live
  array, so bookkeeping written into the node by later same-batch
  mutations — the `$length` marker, null markers — landed on the array as
  real properties (`Object.keys` showed them, and assigning the array
  elsewhere was rejected for carrying a reserved key). Diff values are now
  always the diff's own copies, and a recorded wholesale array is treated
  as a real array by the recorder (its length is the marker)
- **Truncating then regrowing an array in one batch left stale elements on
  receivers** *(fuzzer)*: `arr.length = 0; arr[2] = x` emitted
  `{ 2: x, $length: 3 }`, and receivers kept their old elements 0 and 1.
  Growth past the length recorded so far now null-fills the gap
- **Same-batch deletions were lost across kind changes** *(fuzzer)*: a key
  deleted, then its container replaced by an array and again by an
  object, emitted the final object without the deletion, so receivers
  kept the key; likewise a subtree lost with its parent and recreated with
  a different kind history. The stale-fill now uses the lost container's
  diff node (where deletions survive as null markers), walks up to the
  earliest lost ancestor, and marks stale keys inside object elements of
  real arrays too
- **Inverse diffs and transaction rollback corrupted arrays and kind
  changes** *(fuzzer)*: an inverse node created as the ancestor of a deeper
  change carried no `$length`, so a rollback after deleting the array
  restored an index-keyed object; nodes were stamped from the live value
  even when the batch had changed its kind; a `$length` truncation applied
  through `patch` skipped the truncated elements; and keys added below a
  container that was deleted and recreated — or whose kind changed — in the
  same batch were not undone. Inverse nodes are now stamped only on
  creation, complete records are tracked so nothing records below them
  except new keys, and gap-fill and null-fill never cross kinds
- **Nested listeners missed replacements** *(fuzzer)*: an empty container
  replacing a subtree (`x = []`) was filtered out as "nothing recorded",
  and a listener under an array replaced by a plain object was never told
  its slot was gone
- **Frozen containers and exotic properties in the constructor argument
  produced phantom diffs.** LazyWatch keeps that object by reference, so a
  frozen/sealed/non-extensible container, a getter, or a non-writable,
  non-enumerable, or non-configurable property could arrive through it;
  a later write then threw natively *after* its diff entry was recorded,
  and the phantom entry rode along with the next batch — the sender
  unchanged, every mirror desynced. The constructor now validates the
  whole tree once (`Utils.assertTrackable`, exposed) and rejects these
  with a `TypeError` naming the path, matching what the `defineProperty`
  and `preventExtensions` traps already enforce on live state. Values
  assigned later were always cloned and are unaffected
- **Array deletions emitted fragments without `$length`.** `delete arr[i]`,
  `arr[i] = undefined`, and applier deletions on arrays (a `null` in a
  received fragment, a hole in a wholesale source array) emitted
  `{ i: null }` with no marker, so a receiver that lacked the field stored
  a plain object instead of reviving an array. Deletions now stamp
  `$length` like every other array fragment (inverse diffs too), so all
  array fragments are self-describing on the wire
- **Writes through a detached nested proxy desynced mirrors.** A handle to
  an element (`const todo = app.todos[1]`) whose slot was later removed by
  `shift`/`splice`, deleted, replaced by a leaf, or truncated away still
  accepted writes: they mutated an object no longer in the tree while
  recording a diff at the stale path, so the sender's state stayed
  unchanged and every mirror grew a phantom entry. Tracked writes through
  a detached proxy — assignment, `delete`, array methods, and
  `patch`/`overwrite` entering at it — now throw an `Error` naming the
  path; reads and symbol-keyed writes still work. Handles whose slot
  survives keep addressing that slot (a handle displaced by `unshift`
  edits whatever moved in), now documented under
  [Detached Proxies](docs/API.md#detached-proxies)
- **Nested listeners on array elements missed structural changes.** A
  `$splice` op or a `length` truncation changes what a slot holds without
  naming its index, so a listener on `app.todos[1]` (or anything below it)
  was never notified by `unshift`/`shift`/`splice` or `todos.length = 1`,
  although the docs promised `null` on deletion. Structural ops are now
  recorded per index while such a listener exists (see Breaking), so it
  receives the exact diff for its slot, and a truncated slot delivers
  `null`. A slot reported gone is not re-notified by later growth below it

## [5.0.0] - 2026-07-24

**Breaking wire-format change.** Array fragments now carry their length
under the reserved `$length` marker instead of the `length` key
(`{ 1: 'b', $length: 2 }`, `{ $splice: [[0, 0, ['a']]], $length: 3 }`).
The old form overloaded a legal data key: a plain object that happened to
look like `{ 0: 'x', length: 2 }` was byte-for-byte an array fragment on
the wire, so receivers revived it into a real array while the sender kept
an object — a silent-desync hole that no state-side validation could fully
close (the shape could always be assembled incrementally from legal
writes). With the marker moved to a reserved key, the ambiguity is gone
structurally: array-like objects are ordinary, syncable state, and
fragments can never be mistaken for data.

All replicas must upgrade together — 4.x receivers do not understand
`$length` fragments, and there is deliberately no legacy acceptance of
`length`-marked fragments (accepting them would reintroduce the desync for
exactly the array-like data this release legalizes). Diffs persisted by
4.x (send buffers, stored undo histories) cannot be applied by this
version; resync with `snapshot` + `overwrite` instead.

### Changed

- **`$length` replaces `length` as the array-fragment marker** in emitted
  diffs, inverse diffs, `$splice` fragments, and everything
  `patch`/`overwrite`/`composeDiffs` consume. `length` keys in diffs are
  now ordinary data everywhere
- **`$splice` and `$length` are reserved property names** in watched
  state, joining `__proto__` and friends: rejected at every entry point
  (assignment, `defineProperty`, spliced-in items, the constructor) with a
  `TypeError` naming the key and path. Receivers consume or drop these
  keys instead of storing them, so state carrying them could never arrive
  on a mirror. Being key-level, the check cannot be bypassed by building a
  value incrementally
- `Utils.assertSupported` gained an internal diff-context flag, exposed as
  `Utils.assertSupportedDiff(value, path)`: same rules, except the wire
  format's reserved keys are allowed. Applier and `composeDiffs` sources
  validate through it. `Utils.isReservedDiffKey(key)` is exposed alongside
  `isUnsafeKey`; `Utils.isArrayDiff`/`reviveArrayDiffs` now speak the
  `$length`-marked format (data corrupted by pre-4.2 versions carries the
  old form — repair it with a 4.x release before upgrading)

### Fixed

- **`$splice` in watched state silently desynced every mirror.** A
  property named `$splice` was recorded and emitted by the sender, then
  dropped by every applier (proxy and plain targets alike), leaving the
  sender holding a value no replica had. Now rejected as a reserved name
  (see above)
- **Array-like objects desynced mirrors.** `{ 0: 'x', length: 2 }` in
  state was emitted as bytes identical to an array fragment, so receivers
  without the field revived it into a real array while the sender kept an
  object. Solved structurally by the `$length` rename rather than by
  validation: such objects are now legal state and sync as the objects
  they are, however they are built
- **A rejected `splice`/`unshift` item could leave the array corrupted.**
  Inserted items were validated only on the compact `$splice` recording
  path; the two fallback paths (inverse recording enabled, or pending
  index writes on that array) ran the native method first, so its shift
  writes landed before the per-index set trap rejected the bad item —
  `['b','c'].splice(0, 0, new Map())` threw with the array left as
  `['b','b','c']`. Items are now validated ahead of every branch,
  restoring the documented guarantee that a rejected operation leaves
  state untouched
- **Hostile `$splice` op items are rejected atomically at entry.** Items
  inside a `$splice` op are full values entering state, so diff validation
  holds them to the state rules (no reserved keys, no collection types).
  Previously a diff carrying a poisoned op item could apply sibling keys
  before throwing mid-application on proxy targets, and applied entirely
  on plain targets — the same diff now fails up front on both, leaving
  targets untouched

### Added

- **Pure-truncation fragments revive.** `{ $length: n }` with no index
  keys is unambiguous now that the marker is reserved, so a truncation
  arriving where the receiver lacks the field revives into a real array —
  the old `{ length: n }` form was indistinguishable from data and was
  stored verbatim as an object

## [4.2.0] - 2026-07-24

Deep diffs now cover arrays: replacing an array with a freshly built one
emits only the elements that actually changed, instead of re-sending the
whole array. The wire format is unchanged — receivers on older versions
converge on the same state — and two array-convergence bugs found during
the work are fixed. No API changes.

### Changed

- **Deep diffs now work for arrays**: assigning an array over an existing
  array (`obj.list = [...]`) — and `overwrite`/`patch` with real arrays in
  the source — is diffed element-wise instead of recorded wholesale. Only
  real differences go on the wire as an index-keyed fragment (`{ 0: { cpu: 2 } }`
  instead of the whole array), unchanged elements keep their identity (cached
  child proxies stay valid), changed object elements merge per key with keys
  missing from the new element deleted (full-value semantics, so receivers
  converge to the exact wholesale outcome), and length changes ride along.
  A real array is emitted only when there is no existing array to diff
  against (new property, or a leaf/object slot becoming an array); receivers
  applying such a wholesale array re-emit the difference element-wise, so
  relay chains stay compact. The wire format is unchanged — fragments are
  the form receivers always understood — so mixed-version replicas converge

### Fixed

- Relayed `$splice` ops with object elements could leave stale keys on the
  receiver: the native splice's slot-shift writes merged shifted elements
  into the old slot values without delete-missing during patch application
  (sender `[{ b: 2 }]`, receiver `[{ a: 1, b: 2 }]`). Set-trap merges now
  run with full-value semantics, so the shifted element replaces the slot
  exactly and mirrors converge
- Assigning a real array over a plain object (`obj.slot = [7, 8]` where
  `slot` was `{ a: 1 }`) merged the array into the object, leaving a plain
  object with index keys (`{ 0: 7, 1: 8 }`) instead of an array. It is now
  a wholesale replacement, locally and on the wire

## [4.1.0] - 2026-07-21

Feature and hardening release: `patch`/`overwrite` now work on normal
objects too, the undo manager learns step grouping and coalescing, emits
can align to animation frames via a custom scheduler, and a set of
correctness holes around array reordering and untracked writes is closed.
No API is removed — `patchObject`/`overwriteObject` continue to work as
deprecated aliases.

### Changed

- `LazyWatch.patch` and `LazyWatch.overwrite` now accept **either** a
  LazyWatch proxy or a normal object. On a proxy the behavior is
  unchanged (tracked, recorded, emitted); on a normal object the same
  applier runs with the same semantics but no change tracking.
  `overwrite` on a normal object deletes properties missing from the
  source at every nesting level (arrays exempt, as on proxies) — the
  reconnect-snapshot primitive for plain mirrors such as a Vue
  `reactive` object, where merge semantics would keep keys alive that
  were deleted while disconnected. A disposed proxy still throws rather
  than degrading to the untracked mode, and a target that is neither a
  proxy nor a plain object/array (a `Date`, `Map`, primitive, ...) is
  rejected with a TypeError
- Documentation restructured: the README is now a short overview — pitch,
  quick start, and an API table — and the full API reference (every
  method, the diff wire format, and the supported-value rules) moved to
  `docs/API.md`. Heading anchors were preserved, so existing deep links
  keep working with the path swapped. New size badges (bundlejs min+gzip,
  zero dependencies) advertise the footprint — bundlejs rather than
  bundlephobia, whose analysis pipeline fails on ESM-only packages

### Added

- Undo-step grouping and coalescing: `manager.group(callback)` records
  every batch the callback emits as **one** undo step (composite
  operations like "apply template"), and the `coalesce` option (ms,
  sliding window) merges rapid batches — a typing burst — into a single
  step, with `manager.checkpoint()` as an explicit "undo stop". Merged
  batches are composed into compact diffs via the `composeDiffs` algebra;
  the rare non-composable pairings are kept as sequential segments inside
  the step, so merging never loses correctness. Undo/redo apply a whole
  step before one synchronous flush — mirrors receive it as a single
  batch
- Custom scheduler option: `new LazyWatch(obj, { schedule: cb =>
  requestAnimationFrame(cb) })` dispatches emits inside a callback passed
  to the scheduler instead of a queued microtask — a UI emits at most one
  batch per frame, aligned to the frame boundary. Any deferral works
  (`setImmediate`, idle callbacks, a test harness's fake clock). The first
  change of a batch schedules exactly one slot and later changes ride
  along; combined with `throttle`/`debounce`, the timer decides when an
  emit becomes due and the scheduler aligns the actual emission.
  `LazyWatch.flush` still emits synchronously, and slots outlived by a
  flush, pause, or dispose fire as harmless no-ops
- Bundle-size budget check: `npm run test:size` bundles and minifies the
  library with esbuild, gzips it, and fails when the result exceeds the
  8 kB budget (~6.5 kB actual when added). Runs in CI on every push and
  pull request, keeping the README's size claim honest
- Coverage thresholds in CI: `npm run test:coverage` runs the suite under
  `c8` (fetched via npx — still no devDependencies) and fails below
  95% statements/lines, 88% branches, 98% functions (~98/91.6/100 actual
  when added). The coverage table is published to the CI job summary
- Performance regression guard: `npm run benchmark:check` (and the CI
  benchmark job, via `--check`) fails on order-of-magnitude regressions.
  Ratio guards compare LazyWatch against the plain-object baselines
  measured in the same run — machine speed cancels out, so the check is
  stable on noisy shared runners — with limits ~10x above current ratios,
  catching an accidental O(n²), a hot-path clone, or a synchronous emit
  rather than micro-drift; absolute ops/sec floors cover benchmarks with
  no plain baseline. The guard table prints on every core benchmark run
  but only fails the process under `--check`
- Framework adapter examples in EXAMPLES.md: two Vue 3 patterns — a
  `reactive` object as the state with plain-object `patch` as the wire
  applier (no adapter, no client-side instance; fits server-owned state)
  and a `reactive` mirror of a LazyWatch instance for clients that also
  emit diffs — plus a Svelte store-contract wrapper and a React
  `useSyncExternalStore` hook (version counter + direct proxy reads, with
  nested proxies giving per-component subtree subscriptions), with
  guidance on which pattern fits which framework

### Deprecated

- `LazyWatch.patchObject` and `LazyWatch.overwriteObject` (the latter
  never released) are now thin aliases delegating to the unified
  `patch`/`overwrite`. Existing code keeps working unchanged; new code
  should use the unified names

### Fixed

- `sort()`, `reverse()`, and `copyWithin()` no longer corrupt arrays of
  objects. Run natively through the proxy, their read-all/write-back
  pattern collided with slot-merge semantics: the raw object at a written
  slot was mutated in place while still being the pending source for a
  later slot, so later writes read already-overwritten state — sorting
  `[{n:3},{n:1},{n:2}]` produced `[{n:1},{n:2},{n:1}]`, silently losing an
  element. The three methods are now intercepted like
  `splice`/`unshift`/`shift`: the final arrangement is computed on a
  detached copy and relocated elements are cloned before write-back, so
  recording, inverse capture, and echo semantics all run normally. Only
  relocated slots emit; sorting an already-sorted array emits nothing, and
  a throwing sort comparator leaves state untouched. (`splice`'s own
  element shifts were never affected — its move order cannot overwrite a
  slot it has yet to read.) Sort comparators now see raw elements rather
  than proxies; reads behave identically, and comparators must not mutate
- `LazyWatch.patch` and `LazyWatch.overwrite` now work correctly on nested
  proxies: the diff is recorded and emitted at the subtree's path.
  Previously the state updated correctly but the diff was recorded at the
  root — `LazyWatch.patch(app.user, { name: 'Bob' })` emitted
  `{ name: 'Bob' }` instead of `{ user: { name: 'Bob' } }`, desyncing
  every mirror (and `overwrite` emitted root-level deletions). Inverse
  recording follows the corrected paths too. Source validation now also
  runs for nested entry points (the gate is an explicit internal flag
  instead of a path-emptiness check, which a nested entry used to slip
  past)
- Closed the remaining untracked-write holes with three new proxy traps:
  - `Object.defineProperty` previously mutated watched state with nothing
    recorded or emitted — a silent mirror desync. Descriptors whose net
    effect equals a plain assignment (a data descriptor whose resulting
    property is enumerable, writable, and configurable; attributes absent
    from the descriptor inherit the live property's) are now routed
    through the tracked write path. Accessors and non-default attributes
    are rejected with a TypeError. Symbol keys remain local-only and
    unrestricted
  - `Object.setPrototypeOf` could swap the prototype of watched state
    (the `__proto__` assignment guard did not cover it); it now throws.
    Re-asserting the current prototype remains a harmless no-op
  - `Object.freeze`, `Object.seal`, and `Object.preventExtensions` now
    throw up front instead of half-freezing the target and making later
    tracked writes fail midway with a confusing native error

## [4.0.0] - 2026-07-19

Sync-convergence correctness release, plus a built-in undo manager and
diff composition. Breaking changes are listed first — most 3.x code
upgrades unchanged unless it relied on one of those specific behaviors.

### Breaking

- Class instances (any non-plain object) are now **rejected with a
  TypeError** at every entry point, naming the class and offending path.
  Previously they were silently accepted and stripped of their prototype
  on clone — methods vanished with no error, the same half-tracking
  failure mode for which Map/Set were already rejected. Store the
  instance's data as a plain object, or stash the live instance under a
  symbol key for local-only state. Null-prototype objects
  (`Object.create(null)`) and cross-realm plain objects remain supported
  (`Utils.isPlainObject` accepts prototypes null or one step from null)
- Real arrays in diffs are now applied **wholesale** instead of being
  merged element-by-element. A real array in a diff is by definition a
  full replacement value (in-place mutations emit index-keyed fragments,
  which still merge), but receivers merged its object elements into their
  stale counterparts: `w.list = [{b: 2}]` left a mirror holding
  `[{a: 1}]` at `[{a: 1, b: 2}]`. Applies to `patch`, `overwrite`, and
  `patchObject`; relay chains converge because the full array is
  re-emitted. Re-applying an already-applied array is detected by deep
  equality and records nothing, so bidirectional mirrors cannot echo.
  Inverse diffs still apply correctly: their arrays' null markers are
  dropped during the wholesale write, which is exactly the deletion they
  encoded
- TypeScript: diffs are now typed after the watched object.
  `on`/`once`/`off` are generic — listeners receive `Patch<T> | null`
  (and the inverse as `Patch<T> | null`) instead of `any`, giving
  checked, autocompleted property access on diffs; nested-proxy listeners
  are typed after their subtree. `Patch<T>` now treats `Date`/`RegExp` as
  leaf values. Stricter than 3.x: diff access must narrow the nullable
  parameter (nested subtree deletion delivers `null` — the type now
  surfaces a case that always existed at runtime), and callbacks
  explicitly annotated with a mismatched parameter type may need updating
  (`ChangeListener` without a type argument still works)
- `engines.node` raised from `>=16` to `>=22`, matching the tested CI
  matrix (Node 22/24/26 and Bun) and the oldest maintained Node release
  line — Node 16 has been EOL since September 2023 and was never covered
  by CI. The code may still run on older versions (`structuredClone` has
  a fallback), but they are no longer claimed or tested

### Added

- `LazyWatch.createUndoManager(watched, { limit })` — a built-in
  undo/redo manager where every emitted batch is one undoable step:
  `undo()`, `redo()`, `canUndo`, `canRedo`, `clear()`, `dispose()`. Undo
  and redo apply through the normal patch path and emit as ordinary
  batches, so synced mirrors follow undo history automatically. Pending
  changes are flushed into a step before undoing (a just-made change is
  undoable even under throttle/debounce), new changes clear the redo
  stack, and a successful transaction forms a single step. Works on any
  instance — inverse recording is enabled for the manager's lifetime
  (with its documented costs) and restored on `dispose()`; disposing the
  instance disposes its manager. One manager per instance; root proxy
  required
- `LazyWatch.composeDiffs(older, newer)` — pure composition of two
  sequential diffs into one equivalent diff (patching the result equals
  patching both in order). The primitive for offline send buffers and
  undo-step coalescing: object fragments merge recursively with the newer
  winning, `null`/leaf/wholesale-array values in the newer diff win
  outright, `$splice` op lists concatenate, and fragments over wholesale
  container values are materialized. Two pairings have no single-diff
  representation and throw a TypeError naming the path — an object diff
  following a deletion or leaf write (it would merge into receivers'
  stale value), and `$splice` ops following index writes (receivers apply
  ops before index keys) — so callers catch and fall back to applying the
  diffs separately. Verified by a fuzz test folding random batch diffs
  with fallback against a patched mirror
- `Utils.deepEqual`, `Utils.cloneWithoutNulls`, and `Utils.isPlainObject`
  are exposed on `LazyWatch.Utils`

### Fixed

- Destroying a container and recreating it as an object **within one
  batch** no longer desyncs patch-based mirrors. Previously the
  recreation overwrote the recorded deletion in the diff, so receivers
  merged the new object into their still-live stale container
  (`delete w.k; w.k = {b: 2}` emitted `{k: {b: 2}}` and a mirror holding
  `{k: {a: 1}}` ended at `{a: 1, b: 2}`). The destroyed container is now
  remembered for the rest of the batch — across all destruction paths:
  `delete`, `undefined` assignment, replacement by a leaf,
  `patch`/`overwrite` deletions, and array truncation — and the
  recreation's diff records `null` for every stale key the new value
  doesn't carry (recursively through shared nested objects), so receivers
  delete exactly what they still hold. The null markers exist only on the
  wire, never in local state
- `patch`/`overwrite` no longer mutate the caller's diff when setting a
  container value wholesale — the null-stripping that previously deleted
  keys **from the source diff itself** (corrupting it for the next mirror
  it was applied to) now happens on a private clone, and strips at every
  depth instead of only the top level, so null markers can never be
  stored as literal state
- `patchObject` now adopts a wholesale source array's length, truncating
  the target array's tail — previously `for...in` never visited the
  non-enumerable `length`, so a shorter replacement array (as emitted for
  `obj.list = [...]`) left stale trailing elements behind on plain-object
  receivers, desyncing them from proxy `patch` receivers, which have
  always truncated
- A listener that unsubscribes during an emit (itself or another
  registration) no longer causes the next listener in line to be skipped
  — dispatch now iterates a snapshot of the listener list. Removal during
  emit follows `EventTarget` semantics: a listener removed by an earlier
  listener in the same emit is not invoked, and a listener added during
  an emit first fires on the next batch
- Diffs handed to listeners (and returned by `LazyWatch.silent`) no
  longer share references with live watched state. Previously a wholesale
  container assignment aliased the emitted diff node to the target
  subtree, so mutating that subtree after the emit retroactively rewrote
  diffs a consumer had kept (send buffers, undo stacks, ...).
  `consumeDiff` now returns a deep clone, one clone per batch

### Documentation

- The README API reference now covers the previously undocumented methods
  — `overwrite` (replacement semantics vs `patch`, array exception,
  full-transition emit), `getPendingDiff`, `isProxy`, `resolveIfProxy`
  (with the writes-are-untracked warning), and `dispose` (post-disposal
  behavior of the proxy and its static methods) — plus new sections for
  the undo manager, diff composition, wholesale array semantics, and
  class-instance rejection

## [3.2.0] - 2026-07-18

- feat: Inverse diffs (undo) — `new LazyWatch(obj, { inverse: true })` records
  the patch that undoes each batch; listeners receive it as a second argument
  (path-relative for nested listeners). The inverse survives JSON round-trips
  and applies with `patch`, locally or on a remote mirror. Recording follows
  first-write-wins, gap-fill, and null-fill rules so a batch that mutates,
  deletes, and recreates the same container still undoes exactly. With
  inverse tracking on, structural array ops fall back from compact `$splice`
  to per-index diffs (correct, just larger)
- feat: Add `LazyWatch.transaction(watched, callback)` — applies the
  callback's changes atomically on any instance: on throw, every change is
  rolled back and nothing emits; on success, changes emit as one normal batch
  and the callback's return value is returned. Pending pre-transaction
  changes are flushed first; callbacks must be synchronous; nesting throws
- feat: `LazyWatch.on` and `LazyWatch.once` return an idempotent unsubscribe
  function that removes exactly that registration — `const stop = LazyWatch.on(...)`;
  `stop()`. With an already-aborted signal a no-op function is returned
- feat: Add `LazyWatch.snapshot(watched)` — a deep-cloned plain copy of the
  current state (no proxy, no shared references), safe to mutate or serialize.
  Works on the root proxy or any nested proxy (snapshotting that subtree)
- docs: EXAMPLES.md gains a WebSocket mirroring example — snapshot on
  (re)connect, plain diffs while connected, echo suppression for bidirectional
  sync, and a closure-scoped sequence number pattern for non-TCP transports
- docs: README gains a "Scope and Non-Goals" section — LazyWatch targets
  single-writer-per-property / server-ordered sync with last-writer-wins
  resolution; concurrent multi-writer conflict resolution (CRDTs/OT) is an
  explicit non-goal, with pointers to Yjs/Automerge for those cases
- ci: The test workflow gains a benchmark job — the full suite (~16s) runs on
  every push and pull request, with results published to the job summary
- ci: Test matrix drops Node 20 (EOL April 2026) and adds Node 26 (Current)
  and Bun, covering oldest-supported LTS, active LTS, Current, and Bun;
  `actions/checkout` and `actions/setup-node` bumped to v5 (the v4 actions
  run on Node 20 internally, which GitHub deprecated on its runners)
- refactor: Shrink `Utils.deepClone`'s manual fallback (used when
  `structuredClone` is missing or throws) to the types that can actually occur
  in watched state: plain objects, arrays, Date, and RegExp. Functions are now
  copied by reference on the fallback path (previously they were mangled into
  empty objects via `new obj.constructor()`), and the per-key object-spread
  copy loop is replaced with a plain loop
- fix: A `patch()` that throws mid-validation (e.g. a `Map` in the source) no
  longer leaves the internal patch-mode flag set, which silently turned every
  subsequent `overwrite()` on that instance into a merge that never deleted
  missing properties
- fix: Nested-proxy listeners are now notified when their subtree is deleted
  (called with `null`, matching the null-means-delete diff convention) or
  replaced wholesale by a leaf value (called with that value). Previously a
  deletion or replacement by `null`/number/boolean silently skipped the
  listener — a subscribed mirror kept stale state forever — while replacement
  by a non-empty string accidentally invoked it with the raw string. An
  ancestor being deleted or replaced by a leaf also notifies with `null`
- fix: `Date`/`RegExp` leaf replacements of a watched subtree no longer skip
  nested listeners (the old emptiness check treated them as empty diffs)
- fix: `off()` now removes the registration made on the proxy it is called
  with. Previously it removed the first registration of the function
  regardless of path, so with the same callback on two nested proxies,
  `off(w.b, fn)` could remove the `w.a` registration and leave `b` firing.
  `AbortSignal` removal is likewise scoped to the registration the signal
  was passed to
- tests: Cover patch atomicity after rejection, subtree deletion/replacement
  notification (including falsy leaves and ancestor destruction),
  untouched-subtree silence, path-scoped `off()`/abort removal, unsubscribe
  functions, snapshots (independence, subtrees, disposal), and the manual
  `deepClone` fallback (function references, cycles)

## [3.1.1] - 2026-07-18

- perf: Cut per-write allocations on the hot path — primitive assignments skip
  the validation call (and its path-array allocation) entirely, and
  `Utils.assertSupported` walks objects with a single push/pop path array and
  builds error strings only on the (cold) failure path, instead of allocating
  a path copy and a closure per node visited. Write-path benchmarks improve
  roughly 5-20% depending on the operation; reads are unchanged
- refactor: Split the bidirectional proxy cache into two named WeakMaps
  (`#proxies`: target → proxy, `#proxyPaths`: proxy → path) and remove a
  write-only root mapping nothing ever read; `dispose()` now clears both

## [3.1.0] - 2026-07-18

- feat: Add `LazyWatch.flush(watched)` — synchronously emit pending changes,
  bypassing microtask batching, throttle, debounce, and pause state
- feat: `LazyWatch.on` accepts an options object: `{ once }` removes the
  listener after its first invocation, `{ signal }` removes it when an
  `AbortSignal` aborts (an already-aborted signal never adds the listener).
  `LazyWatch.once(watched, listener, options)` is shorthand for
  `on(..., { once: true })`; nested-proxy once-listeners are only consumed by
  batches that touch their subtree
- feat: Symbol-keyed properties are local-only metadata — stored on the
  underlying object but never recorded, emitted, or synced; exempt from value
  validation and never proxied. Previously symbol writes were half-tracked:
  recorded into the diff (where JSON silently dropped them) and leaking symbol
  keys into emitted diff objects
- ci: The publish workflow also runs the TypeScript definition tests; README
  gains a CI badge
- security: Block prototype pollution through received diffs. `__proto__`,
  `constructor`, and `prototype` are now reserved property names: writes into
  watched state reject them with a `TypeError`, `patch`/`overwrite`/`patchObject`
  refuse diffs containing them before touching any state, the appliers and
  `Utils.reviveArrayDiffs` skip them as defense-in-depth, and the `get` trap no
  longer wraps them in proxies (previously `watched.__proto__` returned a
  watchable proxy of `Object.prototype`). Prior to this fix, a malicious or
  corrupt diff such as `{"__proto__": {...}}` applied via `patch` polluted
  `Object.prototype` in the receiving process
- fix: `NaN` and `±Infinity` are rejected with a `TypeError` at write time —
  JSON serializes them as `null`, which receivers interpret as a deletion,
  silently desyncing replicas
- fix: Assigning `undefined` is normalized to a deletion (emitted as
  `{ prop: null }`) — JSON drops `undefined` values from diffs, so the old
  behavior left receivers permanently out of sync
- fix: Deletions applied by `overwrite`/`patch` are recorded in the receiver's
  own diff, so relay chains (A → B → C) propagate them; previously the middle
  replica applied a deletion without re-emitting it
- fix: Truncating an array (`arr.length = n`) now drops pending diff entries
  for indices beyond the new length (the cleanup branch was unreachable due to
  an incorrect guard), producing smaller diffs
- fix: `LazyWatch.getPendingDiff` uses a structured clone instead of a JSON
  round-trip, so `Date` leaf values keep their type
- tests: Cover pollution vectors across all appliers, reserved-name rejection,
  `undefined`/`NaN` wire round-trips, relay-chain deletions, truncation
  cleanup, and `Date` preservation (88 tests total)

## [3.0.0] - 2026-07-18

- feat!: Structural array mutations (`splice`, `unshift`, `shift`) are emitted
  as compact `$splice` ops (`[start, deleteCount, items]` triples applied
  before a fragment's index keys) instead of per-index writes — prepending one
  item to a 1,000-element array now emits ~68 bytes instead of ~34 KB.
  Consecutive ops in a batch append to one op list; if index writes are
  already pending on the array, the op falls back to per-index recording so
  ordering stays correct. Received ops are applied through the receiver's own
  proxy, so relaying mirrors re-emit them compactly, and
  `Utils.reviveArrayDiffs` replays ops when the receiving side lacks the array
  entirely. **Breaking (wire format):** pre-3.0 receivers would merge a
  `$splice` key verbatim into their arrays — all replicas must run ≥ 3.0.0
- feat!: Watched state is validated. `Map`, `Set`, `WeakMap`, `WeakSet`,
  `Promise`, `ArrayBuffer`, and typed arrays are rejected with a `TypeError`
  at every entry point (constructor, assignment, `patch`/`overwrite`/
  `patchObject`) — their internal-slot mutations bypass the proxy and would
  silently desync replicas. `Date` and `RegExp` remain supported as leaf
  values (methods work; only wholesale replacement is tracked). Validation
  runs before any mutation, so rejected operations leave state untouched.
  New helpers: `Utils.assertSupported`, `Utils.rejectedTypeName`
- fix: `main` field pointed at a nonexistent `src/index.js`; both `main` and
  `exports` now resolve to `src/lazy-watch.js`, with `types` exposed in the
  `exports` map
- types: Rewrite `lazy-watch.d.ts` — `LazyWatch` is declared as a const with a
  construct signature returning the watched type itself (the old
  `constructor(): T` annotation was invalid TypeScript, leaving proxies typed
  as an empty class), phantom exports that don't exist at runtime
  (`Utils`, `DiffTracker`, `EventEmitter`, `ProxyHandler`) are removed, and
  `patch`/`overwrite`/`patchObject` accept `Patch<T>` (recursive partial with
  `null` deletions) instead of `Partial<T>`. Compile-time type tests
  (`npm run test:types`) guard both accepted and rejected usage
- chore: Add ISC `LICENSE` file, GitHub Actions test workflow (Node 20/22/24
  plus type-check job), non-zero exit code from the test runner on failure,
  and a `files` allowlist so the npm tarball ships only `src`, README, and
  LICENSE (plus `keywords`, `engines`, `sideEffects` metadata)
- docs: Document the `debounce` option, supported values, and the `$splice`
  wire format

## [2.6.0] - 2026-07-17

- fix: Applying an index-keyed array diff (e.g. `{ 1: 'b', length: 2 }`) to a target
  that lacks the field no longer stores the fragment verbatim as a plain object —
  `patch`, `overwrite`, and `patchObject` now revive such fragments into real arrays,
  so replicas with shape drift converge instead of silently corrupting
- feat: Array diffs always include `length`, making array fragments self-describing
  on the wire (previously `push()` could emit a fragment without it)
- feat: Expose `Utils.isArrayDiff` and `Utils.reviveArrayDiffs` for applications that
  need to repair data corrupted by earlier versions
- tests: Cover missing-field revival, nested fragments, existing-array merging,
  false-positive guards, and replica convergence under shape drift

## [2.4.7] - 2025-12-21

- feat: Add `LazyWatch.patchObject` static method for patching normal (non-proxy) objects
- docs: Update documentation to include patchObject usage

## [2.4.2] - 2025-12-07

- fix: Ensure array `length` is updated on overwrite to keep target/source in sync
- chore: Bump version to 2.4.2

## [2.4.1] - 2025-11-09

- docs: Clarify optional parameters in LazyWatch constructor using default value syntax
- types: Fix JSDoc types for constructor params; rename parameter references from `proxy` to `watched`
- dx: Improve constructor fallback/return to aid editor IntelliSense and code completion

## [2.4.0] - 2025-11-08

- feat: Add nested proxy listeners that receive path-relative diffs
- docs/tests: Document and add tests for nested proxy listener behavior
- bench: Refactor benchmarks for listener notification and throttle/debounce scenarios

## [2.3.0] - 2025-11-07

- feat: Introduce `LazyWatch.silent` to apply changes without triggering listeners
- tests: Streamline and focus silent method tests
- docs: Add README examples and documentation for silent mode

## [2.1.4] - 2025-10-20

- perf: Optimize diff creation in ProxyHandler with lazy initialization to reduce overhead

## [2.1.3] - 2025-10-20

- refactor: Rework `overwrite` in ProxyHandler to track changes via diff and handle array length updates
- perf: Optimize nested object copying behavior

## [2.1.2] - 2025-10-20

- refactor: Improve EventEmitter emit scheduling; add `clearPending` method
- fix: Handle array replacements correctly in ProxyHandler

## [2.1.1] - 2025-10-19

- perf: Use `performance.now()` for higher precision timing in EventEmitter

## [2.1.0] - 2025-10-19 

- feat: Add throttling support with configurable options

## [2.0.0] - 2025-10-08

- refactor!: Rewrite LazyWatch core for modularity and scalability

## [1.4.1] - 2025-06-22

- docs: Update README with detailed usage examples and features

## [1.4.0] - 2025-06-06

- chore: Remove Vue.js-specific dependency code from `index.js`

## [1.3.6] - 2025-06-06

- tests: Add tests for LazyWatch and integrate Jest setup

## [1.3.5] - 2025-04-19

- build: Add `"type": "module"` to `package.json`

## [1.3.4] - 2023-02-27

- build: Add `.npmignore`

## [1.3.3] - 2023-02-27

- build: Remove `type: module` from `package.json`

## [1.3.2] - 2023-02-27

- build: Add `exports` field to `package.json`

## [1.3.1] - 2023-02-27

- fix: Resolve edge cases with arrays

## [1.3.0] - 2023-02-27

- fix: Use forked local `setimmediate` without `process.nextTick` to address NW.js issues

## [1.2.0] - 2023-01-25

- fix: Use `setimmediate` (with browser polyfill) to fix delay issues

## [1.1.8] - 2023-01-24

- perf: Change `setTimeout` delay from 1ms to 0ms to avoid throttling when tab is unfocused

## [1.1.7] - 2022-11-26

- fix: Ensure array `length` updates when patched

## [1.1.6] - 2022-11-14

- chore/docs: Move project to GitHub and improve documentation

## [1.1.4] - 2021-12-15

- fix: Improve array handling for better Vue reactivity

## [1.1.3] - 2021-04-04

- feat: Notify objects of deletes

## [1.1.2] - 2021-03-28

- feat: Notify objects of changes for Vue.js

## [1.1.1] - 2021-02-03

- Published to npm. No additional notes recorded.

## [1.1.0] - 2020-10-28

- Published to npm. No additional notes recorded.

## [1.0.3] - 2020-10-28

- Published to npm. No additional notes recorded.

## [1.0.2] - 2020-10-28

- Published to npm. No additional notes recorded.

## [1.0.1] - 2020-10-27

- Published to npm. No additional notes recorded.

## [1.0.0] - 2020-10-27

- Initial release on npm.

---

Helpful links:

- Package on npm: https://www.npmjs.com/package/lazy-watch
- GitHub Releases: https://github.com/luffs/lazy-watch/releases

[2.4.7]: https://www.npmjs.com/package/lazy-watch/v/2.4.7
[2.4.2]: https://www.npmjs.com/package/lazy-watch/v/2.4.2
[2.4.1]: https://www.npmjs.com/package/lazy-watch/v/2.4.1
[2.4.0]: https://www.npmjs.com/package/lazy-watch/v/2.4.0
[2.3.0]: https://www.npmjs.com/package/lazy-watch/v/2.3.0
[2.1.4]: https://www.npmjs.com/package/lazy-watch/v/2.1.4
[2.1.3]: https://www.npmjs.com/package/lazy-watch/v/2.1.3
[2.1.2]: https://www.npmjs.com/package/lazy-watch/v/2.1.2
[2.1.1]: https://www.npmjs.com/package/lazy-watch/v/2.1.1
[2.1.0]: https://www.npmjs.com/package/lazy-watch/v/2.1.0
[2.0.0]: https://www.npmjs.com/package/lazy-watch/v/2.0.0
[1.4.1]: https://www.npmjs.com/package/lazy-watch/v/1.4.1
[1.4.0]: https://www.npmjs.com/package/lazy-watch/v/1.4.0
[1.3.6]: https://www.npmjs.com/package/lazy-watch/v/1.3.6
[1.3.5]: https://www.npmjs.com/package/lazy-watch/v/1.3.5
[1.3.4]: https://www.npmjs.com/package/lazy-watch/v/1.3.4
[1.3.3]: https://www.npmjs.com/package/lazy-watch/v/1.3.3
[1.3.2]: https://www.npmjs.com/package/lazy-watch/v/1.3.2
[1.3.1]: https://www.npmjs.com/package/lazy-watch/v/1.3.1
[1.3.0]: https://www.npmjs.com/package/lazy-watch/v/1.3.0
[1.2.0]: https://www.npmjs.com/package/lazy-watch/v/1.2.0
[1.1.8]: https://www.npmjs.com/package/lazy-watch/v/1.1.8
[1.1.7]: https://www.npmjs.com/package/lazy-watch/v/1.1.7
[1.1.6]: https://www.npmjs.com/package/lazy-watch/v/1.1.6
[1.1.4]: https://www.npmjs.com/package/lazy-watch/v/1.1.4
[1.1.3]: https://www.npmjs.com/package/lazy-watch/v/1.1.3
[1.1.2]: https://www.npmjs.com/package/lazy-watch/v/1.1.2
[1.1.1]: https://www.npmjs.com/package/lazy-watch/v/1.1.1
[1.1.0]: https://www.npmjs.com/package/lazy-watch/v/1.1.0
[1.0.3]: https://www.npmjs.com/package/lazy-watch/v/1.0.3
[1.0.2]: https://www.npmjs.com/package/lazy-watch/v/1.0.2
[1.0.1]: https://www.npmjs.com/package/lazy-watch/v/1.0.1
[1.0.0]: https://www.npmjs.com/package/lazy-watch/v/1.0.0
