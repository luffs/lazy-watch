# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LazyWatch is a lightweight reactive proxy-based object change tracker for JavaScript. It uses JavaScript Proxies to intercept property access and modifications, batching changes asynchronously to emit diffs. The library is framework-agnostic and works in both Node.js and browsers.

## Development Commands

**Running tests:**
```bash
npm test
```
This executes the test suite via the `test/tests.js` entry point (per-topic suites in `test/suites/`, shared runner/assertions in `test/helpers.js`) using a custom test runner (not Jest). The runner sets a non-zero exit code when any test fails.

`npm test` includes a short fixed-seed pass of the convergence fuzzer (`test/fuzz/convergence.js`, registered via `test/suites/fuzz.test.js`). It drives a sender through random mutation sequences (nested writes, structural array ops, patch/overwrite with perturbed snapshots and hand-built fragments, held handles, delete-and-recreate, throwing transactions, undo/redo) and checks after every batch: a JSON-fed mirror, a relay of that mirror, a plain-object mirror, a `composeDiffs` buffer (applied at checkpoints, refusals falling back to sequential application), inverse restore, nested-listener shadows fed only by deliveries, detached-handle behavior, in undo mode undo-all/redo-all (half the runs with `coalesce`, plus `group()`/`checkpoint()` ops that exercise step merging), and in bidi mode two peers exchanging diffs through inboxes with the documented echo guard, either side writing per step. `npm run fuzz [-- --seed N --runs N --steps N --mode plain|inverse|undo|bidi --trace]` runs a longer campaign; failures print the seed, the last operations, and a reproduction command (`--trace` adds every batch diff, composed buffer, and wire re-emission). Bugs it found are pinned in `test/suites/fuzz-regressions.test.js`.

**Running tests with coverage:**
```bash
npm run test:coverage
```
Runs the suite under `npx c8` (no devDependency) with enforced thresholds: statements/lines 95%, branches 88%, functions 98% (~98/91.6/100 actual when added). If a change legitimately lowers coverage, adjust the thresholds in the `test:coverage` script in the same commit and say why.

**Running benchmarks:**
```bash
npm run benchmark        # full suite (~16s)
npm run benchmark:core   # core performance only
npm run benchmark:memory # memory usage only
npm run benchmark:check  # full suite + regression guard (exit 1 on breach)
```
The regression guard (`benchmark/regression-guard.js`) is order-of-magnitude protection, not a trend tracker: ratio guards compare LazyWatch against the plain-object baselines from the same run (machine speed cancels out; limits ~10x above current ratios), plus conservative absolute ops/sec floors. Ratio guards compare median per-iteration times (throughput carries GC pauses). The read and write benchmarks access an instance created once (1000 reads or writes per iteration rotating over three keys, the write side flushing each batch; creation is batched a hundred per iteration; all declare `workPerIteration` and a `work` description, so the table reports ops/sec per access and says what one iteration did, with timings in µs) rather than constructing one per iteration — a per-iteration construction made the ratio compare allocation and GC against loop overhead, which varied 7x to 118x across machines for identical code. The runner derives ops/sec from summed per-iteration hrtime and awaits only functions that return a promise, so loop bookkeeping is never counted as work. It prints on every core run but only fails the process under `--check`. When a limit trips because of an intentional trade-off, adjust it in the same commit with an explanation.

CI (`.github/workflows/test.yml`) runs tests on Node 22/24/26 and Bun (invoked as `bun ./test/tests.js` — plain `bun test` would run Bun's own test runner instead of this project's), the TypeScript definition checks, the coverage thresholds (report in the job summary), the bundle-size budget check, and the full benchmark suite with the regression guard (results in the job summary) on every push and pull request.

**Checking the bundle-size budget:**
```bash
npm run test:size
```
Bundles/minifies via `npx esbuild`, gzips, and fails if the gzipped size exceeds the budget in `scripts/size.js` (10 kB; ~9.0 kB actual as of the convergence-fuzzer work). When the printed size drifts from the "~9 kB min+gzip" claim, update README.md along with the budget.

## Documentation Layout

- `README.md` — pitch, quick start, and an API overview table; keep it short
- `docs/API.md` — the full API reference, diff wire format, and supported-value rules (moved out of the README; heading anchors were preserved, so deep links like `docs/API.md#undo-manager` are stable)
- `EXAMPLES.md` — real-world recipes
- New/changed API behavior must be documented in `docs/API.md`; the README only gets a table entry or one-liner.

## Configuration Options

LazyWatch accepts an optional second parameter with configuration options:

```javascript
const watched = new LazyWatch(original, {
  throttle: 50,  // Minimum time in ms between emits (default: 0)
  debounce: 100, // Wait for quiet period before emitting (default: 0)
  schedule: cb => requestAnimationFrame(cb) // Custom emit scheduler (default: none)
});
```

When `throttle` is set, the EventEmitter implements throttling to reduce emit frequency for high-frequency updates. When `debounce` is set, each new change resets the timer and the diff is emitted once no changes occur for the debounce period. If both are set, `debounce` takes precedence.

When `schedule` is set, emits are dispatched inside a callback passed to the scheduler instead of a queued microtask (e.g. at most one batch per animation frame). Combined with `throttle`/`debounce`, the timer decides when an emit becomes due and the scheduler aligns the actual emission. `flush` still emits synchronously, bypassing it.

## Architecture

### Core Components

The codebase follows a modular architecture with clear separation of concerns:

1. **LazyWatch** (`src/lazy-watch.js`) - Main class that coordinates all components
   - Instantiation returns a Proxy (not the LazyWatch instance itself)
   - Uses private fields and WeakMap to manage instance-to-proxy mapping
   - All public API methods are static and operate on proxies

2. **ProxyHandler** (`src/proxy-handler.js`) - Manages proxy creation and trapping
   - Creates nested proxies recursively for deep watching
   - Uses WeakMap cache to avoid creating duplicate proxies
   - Handles `overwrite()` (replace + delete) vs `patch()` (merge only) semantics; both accept a base `path` so external calls entering at a nested proxy record the diff at the subtree's path (`LazyWatch.patch`/`overwrite` pass `getProxyPath(watched)`), and source validation is gated by an explicit `internal` flag rather than path emptiness
   - Uses symbol markers (PROXY_TARGET, LAZYWATCH_INSTANCE) for internal access
   - Traps beyond get/set/deleteProperty: `defineProperty` routes descriptors equivalent to a plain assignment (data value; resulting property enumerable/writable/configurable, absent attributes inheriting the live property's) through the shared `#applySet` write path and rejects accessors and non-default attributes; `setPrototypeOf` (to a new prototype) and `preventExtensions` (freeze/seal) throw — all three previously mutated the target silently or half-froze it
   - Every tracked write (`#applySet`, `deleteProperty`, structural/reorder array ops, and external `overwrite`/`patch` entry) first runs `#assertAttached(target, path)`: the raw object behind a proxy is either still at the proxy's path or detached from the tree entirely (assigned values are cloned, containers merge in place), so a mismatch means a stale handle and the write throws instead of mutating an unreachable object while recording a diff at a dead path. Reads and symbol-keyed writes are exempt. `valueAt(path)` exposes the same own-property walk to the emitter

3. **DiffTracker** (`src/diff-tracker.js`) - Accumulates changes into nested diff objects
   - Maintains a master diff structure that mirrors the watched object's shape
   - Holds a reference to the live root (constructor argument) so `getDiffObject(path)` can stamp `$length` on every diff node created for an array — the write target and every array ancestor — making all array nodes self-describing on the wire; only nodes created by the walk are stamped (an existing node may describe a value of another kind than what lives there now), and length-changing ops keep the stamp current. `peekDiffObject(path)` looks up without creating
   - A wholesale array assigned this batch is a real-array copy in the diff (`ProxyHandler.#setDiffLength` sets its `length` instead of `$length`; compact `$splice` recording is skipped on such a node); diff values never alias live state — every recorded container is the diff's own copy — so `consumeDiff()` hands out the master diff as-is
   - `consumeDiff()` returns and clears the accumulated changes
   - Keeps a per-batch registry of destroyed containers (`recordContainerLoss`/`getContainerLoss`, cleared on `consumeDiff`), each with the diff node it had at loss time and an order: when a slot whose container was deleted/leaf-replaced/kind-changed/truncated this batch is recreated with a same-kind container, `ProxyHandler.#staleFilledDiffValue` null-fills the recreation's diff for every key receivers may still hold — the lost container's keys and every key of its node (deleted keys survive only as node null markers), recursing through same-kind containers including object elements of real arrays — so receivers delete the stale keys they still hold; the markers go on the wire only, never into local state. `getContainerLoss` walks up to the earliest lost ancestor when one was lost before the slot itself (receivers are at the pre-batch state)
   - When `inverseEnabled` (set by the `inverse` constructor option, or temporarily by `LazyWatch.transaction`), also records a master inverse diff — a patch fragment that undoes the batch. `consumeInverse()` must be consumed in lockstep with `consumeDiff()`. Recording rules: first-write-wins (a key's inverse is its value before the batch's first change), gap-fill (deleting/replacing a container backfills its not-yet-recorded keys from the live value), null-fill (keys a replacement introduces are recorded as `null` so undo deletes them). A recorded leaf/null/wholesale-array entry is complete — recording below it is skipped. Object clones recorded for a replaced/deleted container (and partial fragments once gap-filled) are tracked in `#completeInverse`: below them only keys new since the batch started are recorded (as `null`, plus null-fill of same-kind container replacements), and nothing at all when the batch has since put a container of the other kind there — undo replaces across kinds wholesale. `#nullFill` and `#gapFill` never cross kinds

4. **EventEmitter** (`src/event-emitter.js`) - Batches and emits change notifications
   - Schedules emission using `queueMicrotask` for async batching
   - Multiple synchronous changes trigger only one listener invocation
   - Error handling prevents one failing listener from affecting others
   - Supports throttling (`options.throttle`) and debouncing (`options.debounce`)
   - Tracks `lastEmitTime` and uses `setTimeout` for delayed emits when throttling or debouncing
   - Supports a custom scheduler (`options.schedule`): emits dispatch inside a callback handed to it instead of a queued microtask. One live dispatch per batch, whichever kind (`#scheduledGeneration` marker for microtasks and custom slots, a pending `#timeoutId` for throttle timers — the first change schedules, later changes ride along; only the debounce timer is re-armed per change); dispatches outlived by flush/pause/dispose no-op via the generation check since custom schedulers have no cancel handle. Scheduling per change used to cost ~300 bytes of garbage per write and dominated the write path. Timer-due emits (`#emitDue`) and immediate emits (`#scheduleImmediate`) both route through the scheduler when one is set
   - `on()` returns an idempotent unsubscribe function scoped to that exact registration (a no-op function when the signal is already aborted); `off()` and abort removal are path-scoped, so the same callback on two proxies are distinct registrations. Every removal goes through `#remove`, which flags the entry (`removed` — an emit iterating a snapshot skips it in O(1)) and detaches the entry's abort handler, so a long-lived signal never keeps a disposed instance reachable
   - Listener options: `{ once }` (removed after first invocation; nested-path listeners only consume on batches touching their subtree) and `{ signal }` (AbortSignal removal, addEventListener semantics)
   - Nested-path listeners receive path-relative diffs; when their subtree (or an ancestor) is deleted they are called with `null`, and when it is replaced wholesale by a leaf value they are called with that value. `#filterDiffByPath` uses `undefined` as the "batch didn't touch this path" sentinel (safe because diffs never store `undefined`)
   - `hasListenersBelow(path)` makes `ProxyHandler.#structuralArrayOp` fall back to per-index recording while any listener sits below an array, so element listeners get exact slot diffs (a compact `$splice` cannot say what moved in). `#filterDiffByPath` delivers `null` for a slot a real array value lacks, for an index at or beyond a fragment's `$length`, and — the one shape the diff alone cannot decide, an unmarked object at an index step — when the live tree says the path is gone (state resolver injected via `setStateResolver`, wired to `ProxyHandler.valueAt`). Every non-`undefined` filter result is delivered, empty containers included (diff nodes are only created when something is recorded, so an empty container is always a real value). Listener entries carry a `gone` flag so a slot already reported gone is not re-notified by later `$length` growth below it
   - `LazyWatch.flush(watched, meta)` exposes `forceEmit(meta)`: synchronous emit bypassing batching, throttle, debounce, and pause. Batch metadata (an object, by convention `{ origin }`, validated by `LazyWatch.#assertMeta`) is handed to every listener as the third argument; only synchronous emits carry one. `LazyWatch.patch`/`overwrite` with metadata run `#applyTracked`: force-emit pending (untagged), apply, force-emit tagged — so the tagged batch is exactly the applied diff. The UndoManager's injected `flush(meta)` tags undo/redo batches `{ origin: 'undo' | 'redo' }`

5. **UndoManager** (`src/undo-manager.js`) - Undo/redo stacks built on inverse diffs
   - Created via `LazyWatch.createUndoManager(watched, { limit, coalesce })`; one per instance (tracked in a `LazyWatch.#undoManagers` WeakMap), root proxy only, disposed automatically when the instance is disposed
   - Dependency-injected (subscribe/flush/patch/hasPending/compose/onDispose closures built in the static factory), so the class never touches LazyWatch internals directly; a constructor throw (bad option) restores the instance's `inverseEnabled` in the factory
   - A step is a non-empty array of `{ diff, inverse }` segments (a plain batch = one segment); undo applies segment inverses newest-first, redo forward diffs oldest-first — all before one synchronous flush, so other listeners receive the whole step as a single batch while an `#applying` guard keeps the manager's own listener from recording it (mirrors follow undo)
   - `group(cb)` records every batch the sync callback emits as one step (flushes before/after; not a transaction — a throw keeps applied changes and rethrows); `coalesce` (ms, sliding window tracked via `#openStep`/`#openStepTime`) merges rapid batches into the open step; `checkpoint()` ends the window. Merges compose into the last segment via injected `composeDiffs` (inverse pair composed newer-first) and fall back to appending a segment when the pair throws
   - `undo()`/`redo()` flush pending changes first (pending counts toward `canUndo`); new changes clear the redo stack
   - `record` option (`(meta, diff) => boolean`): a batch it declines is not recorded; instead `#invalidate` walks the batch's forward diff and inverse together (`collectShapeChanges`: kind change between them, a real array on either side, a differing `$length` or a `$splice`) and drops every step in either stack whose diff or inverse `touches` such a path (a node at the path, or a complete value — leaf, null, real array — over an ancestor); a dropped open step is closed so the next batch starts fresh. Field-level foreign writes never invalidate (last-writer-wins). The bidi fuzzer mode attaches a manager with this filter to the sender
   - Attach flushes pending changes (kept out of history), then enables `inverseEnabled` for the manager's lifetime; `dispose()` restores the prior setting (discarding a half-recorded inverse when the instance had it off)

6. **diff-compose** (`src/diff-compose.js`) - Pure composition of sequential diffs, exposed as `LazyWatch.composeDiffs(older, newer)`
   - Contract: `patch(S, compose(a, b))` ≡ `patch(patch(S, a), b)` for receivers the pair itself would converge; output shares no references with inputs
   - Newer wins per key (`null`/leaf/wholesale-array outright; object fragments merge recursively); `$splice` lists concatenate; a fragment over a wholesale array value is materialized via an injected `applyFragment` (LazyWatch's `#patchObjectInto`)
   - Throws TypeError (path-named) on the un-composable pairings: object diff over a deletion/leaf, an unmarked plain object over an array value or marked fragment (a receiver still holding an object would merge instead of replace), an object written into a slot the older diff truncated away, and `$splice` ops after index writes (receivers apply ops before index keys). Array fragments over a deletion/leaf/object escape via `reviveArrayDiffs` (self-describing `$length`); a newer truncation drops the older diff's index keys beyond it, an older truncation followed by growth null-fills the gap (shifted by the newer ops' net length change), and a pure-op older fragment's interim `$length` is dropped when newer ops follow

7. **Utils** (`src/utils.js`) - Helper functions for type checking and cloning
   - `isObjectOrArray()` determines if value should be proxied; returns false for leaf values
   - `hasArrayMarker(value)` (numeric `$length` or `$splice` list; null-safe, false for leaves and real arrays) tells an array fragment from a plain object; `canMerge(target, source, wholesale)` is the single merge-or-replace rule both appliers use: same-kind containers merge, a real array replaces an object, an unmarked object replaces an array, and a marked fragment replaces a plain object with its revived array
   - `deepClone()` creates copies of objects/arrays for diff storage; uses `structuredClone` when available, with a manual fallback for plain objects, arrays, Date and RegExp (general-purpose — the latter two are rejected from watched state) and functions by reference. Also backs `LazyWatch.snapshot(watched)`, which returns an independent plain clone of the root or a nested subtree

### Data Flow

1. User modifies proxy → ProxyHandler intercepts via `set` trap
2. ProxyHandler records change in DiffTracker at appropriate path
3. ProxyHandler calls EventEmitter.scheduleEmit()
4. EventEmitter uses queueMicrotask to batch changes
5. On the next microtask: EventEmitter consumes diff and calls all listeners
6. DiffTracker is cleared for next batch

### Key Design Patterns

- **Proxy recursion**: When accessing nested objects, proxies are created/cached on-demand
- **Symbol-based introspection**: PROXY_TARGET and LAZYWATCH_INSTANCE symbols allow controlled access to internals without polluting the API surface
- **Path tracking**: Changes are recorded with path arrays (e.g., `['user', 'profile', 'name']`) to build nested diff structure
- **Batching**: queueMicrotask ensures multiple synchronous mutations appear as single change event

## Important Implementation Details

### Proxy Return Pattern
The constructor returns a Proxy, not the LazyWatch instance. This means:
- `const watched = new LazyWatch({})` → `watched` is a Proxy
- Static methods accept proxies: `LazyWatch.on(watched, callback)`
- Internal methods use `#getInstance(proxy)` to retrieve the LazyWatch instance from WeakMap

### Unified Targets for patch/overwrite
`LazyWatch.patch(target, source)` and `LazyWatch.overwrite(target, source)` accept **either** a LazyWatch proxy or a normal object (`patchObject`/`overwriteObject` remain as deprecated aliases delegating to them, for 4.0.0 compatibility):
- Dispatch via `#tryGetInstance` (symbol probe + WeakMap fallback): a proxy routes through the tracked ProxyHandler path (diff recorded/emitted at the proxy's path); anything else goes to the plain applier `#patchObjectInto` — same semantics, no recording or emission, sources deep-cloned to prevent reference sharing
- A **disposed** proxy still resolves to its instance and throws rather than silently degrading to untracked plain mode; a target that is neither (primitive, `null`, `Date`, `Map`, ...) is rejected with a TypeError by `#assertPlainTarget`
- The plain applier handles the full wire format (nested merges, null deletions, `$splice` ops, array-diff revival, wholesale arrays, reserved-key skipping); `overwrite` adds a `deleteMissing` pass at every merged level (arrays exempt — wholesale length adoption handles their tail); `composeDiffs`' injected applier keeps merge semantics
- Plain-target use cases: applying received diffs to a plain mirror (e.g. a Vue `reactive` object) with `patch`, and applying an authoritative snapshot on reconnect with `overwrite` (merge semantics would keep drifted keys alive)

### Delete Semantics
- Property deletion is represented as `null` in diffs (not `undefined`)
- `overwrite()` deletes properties missing from source (except on arrays) — on proxy and plain targets alike, at every merged level
- `patch()` never deletes missing properties (merge semantics); `null` values still delete

### Supported Values
- Only plain objects and arrays are deep-watched; the root must be one
- Values JSON cannot carry faithfully are rejected with a TypeError at every entry point, like the collection types: `Date` (arrives as a string; the sender drifts to a string on echo), `RegExp` (arrives as `{}`), `bigint` (`JSON.stringify` throws), and `symbol`/function values (dropped). Store timestamps or ISO strings, regex source/flags, and numbers instead. `Utils.isObjectOrArray` still returns false for Date/RegExp so the general-purpose `deepClone`/`deepEqual` helpers treat them as leaves
- The constructor argument is kept by reference (everything entering later is cloned), so `Utils.assertTrackable` walks it once at construction and rejects frozen/sealed/non-extensible containers and accessor or non-enumerable/non-writable/non-configurable properties — a write to those fails natively *after* the diff entry was recorded, shipping mirrors a phantom change
- Map, Set, WeakMap, WeakSet, Promise, ArrayBuffer, and typed arrays are rejected with a TypeError at every entry point (constructor, `set` trap, `overwrite`/`patch` on both target kinds) — their internal-slot mutations bypass the proxy and would silently desync replicas
- Class instances (any non-plain object) are rejected the same way: cloning and JSON strip their prototype, silently losing methods. `Utils.isPlainObject` accepts prototypes that are null or one step from null (covers `Object.create(null)` and cross-realm plain objects); the symbol-key escape hatch still allows instances as local-only values
- `Utils.assertSupported(value, path)` performs the cycle-safe deep validation and throws naming the offending path; validation runs before any mutation, so rejected operations leave state untouched
- `NaN`/`±Infinity` are rejected (JSON would serialize them as `null` = deletion); assigning `undefined` is normalized to a deletion (emitted as `null`)
- `__proto__`/`constructor`/`prototype` are reserved names: rejected at write time via `Utils.isUnsafeKey`, skipped by the appliers as defense-in-depth, and never proxied by the `get` trap — this blocks prototype pollution from hostile wire diffs
- `$splice`/`$length` are the wire format's own reserved names (`Utils.isReservedDiffKey`): rejected from state at every entry point (receivers would consume or drop them, silently desyncing), but legal inside diffs, where validation runs through `Utils.assertSupportedDiff`. `$splice` op items are full values entering state, so they get state rules even in diff context — hostile diffs fail atomically at entry. Because the array-fragment marker is `$length` (a reserved key) rather than the `length` data shape, array-like objects like `{ 0: 'x', length: 2 }` are ordinary syncable state
- Deletions applied by `overwrite`/`patch` are recorded in the receiver's own diff so relay chains (A → B → C) propagate them
- Symbol-keyed properties are local-only metadata: stored on the target but never recorded/emitted/synced, exempt from validation (a Map under a symbol key is allowed), and never proxied — a deliberate escape hatch for per-replica bookkeeping

### Inverse Diffs and Transactions
- `new LazyWatch(obj, { inverse: true })` records an inverse diff per batch; listeners receive it as a second argument (path-relative for nested listeners, filtered like the forward diff). Applying it with `patch` restores the pre-batch state; it survives JSON round-trips, so undo works on remote mirrors
- Inverse tracking disables compact `$splice` recording: a `$splice` op cannot be correctly interleaved with per-key inverse entries (receivers apply `$splice` before a node's other keys, breaking chronological undo ordering), so structural array ops fall back to per-index trap recording — correct, just larger
- `LazyWatch.transaction(watched, cb)` works on any instance: it flushes pending changes, enables inverse recording for the callback's duration, and on throw applies the inverse via `ProxyHandler.rollback()` (suppressed — records and emits nothing) and discards the forward diff. Synchronous callbacks only; nesting throws; `flush` inside the callback escapes the rollback scope
- `ProxyHandler.#inverseActive()` gates all capture sites (`recordChange`, both delete paths, truncation, the `overwrite` applier branches); suppression covers structural-op internals and rollback itself
- `LazyWatch.createUndoManager(watched, { limit })` layers undo/redo stacks on top of inverse diffs (see the UndoManager component above); `LazyWatch.silent` changes bypass emission and are never recorded as steps — the `record` option is the supported way to keep foreign batches out of history, because unlike silent changes they still invalidate the steps they conflict with

### Array Handling
- Real arrays in diffs are full values (fragments are the merge form): they mean "this slot is exactly this array", elements included. But array-over-array is **diffed element-wise** on proxy targets (assignment via the set trap, `overwrite`/`patch` appliers alike): length is adopted with trap-equivalent semantics (`#handleArrayLengthChange`), unchanged elements are untouched (identity preserved — cached child proxies stay valid), and only real differences are recorded, so the wire carries a minimal fragment instead of the wholesale array. A `wholesale` flag threads through `overwrite()`: it is set by the set trap (an assigned value is a full value) and inside any real-array source, and forces same-kind-only merging plus delete-missing even in patch mode — receivers converge to the exact wholesale outcome while re-emitting compact fragments (relay chains stay compact). A real array is emitted only when there is no array to diff against (new property, or leaf/object slot becoming an array); kind changes replace wholesale in both directions — a real array assigned over a plain *object* (merging would leave an object with index keys behind), and a plain object assigned over an *array* (merging would leave junk properties on the array; on the wire the unmarked object tells receivers to replace). Sparse-source holes clear the target slot like the wholesale write did. Null markers inside wholesale-applied arrays are dropped during the write (`Utils.cloneWithoutNulls`), which is how inverse-diff arrays encode deletions; a deep-equal re-application records and emits nothing (echo stability, `Utils.deepEqual`)
- Array mutations (push, index writes) are tracked via length and index changes. On the wire, every array node — index writes, structural ops, deletions (`#recordDeletion`), and ancestors of a deeper change alike — carries its length under the reserved `$length` marker (never the `length` data key), so plain data can never be mistaken for a fragment, a pure truncation (`{ $length: n }`) is a self-describing fragment, and an unmarked object over an array is unambiguously a replacement. Growth past the length recorded so far in a batch null-fills the gap (`#setDiffLength`), so truncate-then-regrow leaves no stale elements on receivers. A marked fragment arriving where the slot holds a plain object replaces it with the revived array (`Utils.canMerge`)
- `splice`/`unshift`/`shift` are intercepted in the `get` trap and recorded as compact `$splice` ops (`[start, deleteCount, items]` triples) instead of per-index writes; the mutation still executes as the native method through the proxy, because trap-driven slot-merge semantics keep cached child-proxy paths valid — raw splicing would move elements and stale them
- Compact recording requires a clean diff node for that array (only `$splice`/`$length` keys); otherwise the op falls back to per-index recording so ordering stays correct. Receivers apply `$splice` before merging a node's other keys, and its `$length` marker after them
- `sort`/`reverse`/`copyWithin` are intercepted too (`#reorderArrayOp`): run natively through the proxy, their read-all/write-back pattern corrupts object elements — slot-merge mutates the raw object at a written slot in place while it is still the pending source for a later slot. The final arrangement is computed natively on a detached copy of the raw elements and every relocated element is cloned before the first write-back; the clones then go through the proxy so recording/inverse/echo semantics run normally. Only relocated slots emit; a throwing sort comparator leaves state untouched; comparators see raw elements, not proxies. (`splice`'s native fallback is safe: its move order never overwrites a slot it has yet to read)
- Received `$splice` ops are applied through the receiver's own proxy, so relaying mirrors re-emit them compactly
- Arrays are not trimmed during overwrite operations (only objects are)
- Length changes trigger cleanup of diff indices beyond new length

### Memory Management
- Proxies and targets cached in WeakMap for automatic GC
- `dispose()` method clears all references and listeners
- After disposal, static methods (`on`, `patch`, etc.) throw errors; the proxy's own traps still operate on the underlying target without emitting events

## Module System

This is an ES module project (`"type": "module"` in package.json):
- Use `import`/`export` syntax
- File extensions required in imports (`.js`)
- Entry point: `src/lazy-watch.js` (both `main` and `exports` fields)
- TypeScript definitions: `src/lazy-watch.d.ts` (`types` field)

## Testing

Tests use a custom test runner (`TestRunner` class in `test/helpers.js`), not Jest:
- Tests are async-aware (uses `await` for microtask batching)
- Custom assertion functions: `assertEquals()`, `assertObjectEqual()` — shared assertions and convergence helpers (`assertConverged`, `assertComposeEquivalent`) live in `test/helpers.js`
- `test/tests.js` is the entry point: it builds the runner, registers every suite from `test/suites/` (each exports a `register(runner)` default), prints the usage examples (`test/examples.js`), and runs
- Suites are split by topic (core, timing, listeners, arrays, values, inverse, undo-manager, compose-diffs, convergence, nested-patch, traps, scheduler, plain-targets, deep-array-diffs); add new tests to the matching suite, or a new `test/suites/*.test.js` registered in `test/tests.js`

**Type checking:**
```bash
npm run test:types
```
Compiles `test/types.test.ts` against `src/lazy-watch.d.ts` (never executed; uses `@ts-expect-error` to assert invalid usage is rejected). Note: `LazyWatch` is declared in the `.d.ts` as a const with a construct signature (`LazyWatchStatic` interface), not a class, because the constructor returns a proxy typed as the watched object itself.
