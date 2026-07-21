# LazyWatch API Reference

The complete reference for every LazyWatch API, the diff wire format, and
the supported-value rules. For an overview and quick start, see the
[README](../README.md); for real-world recipes (state management, WebSocket
mirroring, undo/redo, form validation), see [EXAMPLES.md](../EXAMPLES.md).

## Table of Contents

- [Creating Watched Objects](#creating-watched-objects)
  - [With Throttling](#with-throttling) · [With Debouncing](#with-debouncing) · [With a Custom Scheduler](#with-a-custom-scheduler-frame-alignment)
- [Listening for Changes](#listening-for-changes)
  - [One-shot Listeners](#one-shot-listeners) · [Nested Proxy Listeners](#nested-proxy-listeners)
- [Removing Listeners](#removing-listeners)
- [Flushing Pending Changes](#flushing-pending-changes)
- [Inspecting Pending Changes](#inspecting-pending-changes)
- [Taking Snapshots](#taking-snapshots)
- [Pausing and Resuming Event Emissions](#pausing-and-resuming-event-emissions)
- [Silent Mutations](#silent-mutations)
- [Inverse Diffs (Undo)](#inverse-diffs-undo)
- [Transactions](#transactions)
- [Undo Manager](#undo-manager)
- [Applying Changes](#applying-changes)
  - [Patching](#patching) · [Overwriting](#overwriting)
- [Composing Diffs](#composing-diffs)
- [Identifying and Unwrapping Proxies](#identifying-and-unwrapping-proxies)
- [Disposing](#disposing)
- [Array Diffs and Shape Drift](#array-diffs-and-shape-drift)
- [Supported Values](#supported-values)

## Creating Watched Objects

```js
const watchedObject = new LazyWatch(originalObject, options);
```

Creates a proxy around the original object that tracks all changes.

**Parameters:**
- `originalObject` - The object or array to watch
- `options` (optional) - Configuration options
  - `throttle` - Minimum time in milliseconds between emits (default: 0). When set, the first change emits immediately, but subsequent changes within the throttle window are batched together.
  - `debounce` - Time in milliseconds to wait for additional changes before emitting (default: 0). Each new change resets the timer, so the diff is emitted once things go quiet. If both `throttle` and `debounce` are set, `debounce` takes precedence.
  - `schedule` - Custom scheduler for emit dispatch (default: none). A function that receives the emit callback; batches are emitted inside it instead of on a queued microtask. See [With a Custom Scheduler](#with-a-custom-scheduler-frame-alignment).
  - `inverse` - Record an inverse diff per batch (default: false). See [Inverse Diffs (Undo)](#inverse-diffs-undo).

### With Throttling

```js
// Create a watched object with 50ms throttle
const UI = new LazyWatch({}, { throttle: 50 });

LazyWatch.on(UI, diff => console.log({ diff }));

// Multiple rapid changes will be batched
UI.count = 1;
UI.count = 2;
UI.count = 3;
// After 50ms, logs once: { diff: { count: 3 } }
```

### With Debouncing

```js
// Create a watched object with 100ms debounce
const UI = new LazyWatch({}, { debounce: 100 });

LazyWatch.on(UI, diff => console.log({ diff }));

// Each change resets the timer; the diff is emitted once
// 100ms after the last change
UI.count = 1;
UI.count = 2;
UI.count = 3;
// After 100ms of inactivity, logs once: { diff: { count: 3 } }
```

### With a Custom Scheduler (frame alignment)

`throttle` and `debounce` batch by *time*; a custom scheduler batches by
*slot*. When `schedule` is set, emits are dispatched inside a callback
passed to it instead of a queued microtask — with `requestAnimationFrame`,
a UI emits **at most one batch per frame**, aligned to the frame boundary:

```js
const UI = new LazyWatch({}, { schedule: cb => requestAnimationFrame(cb) });

LazyWatch.on(UI, diff => render(diff));

UI.x = 1;
UI.y = 2;
// One emit, inside the next animation frame: { x: 1, y: 2 }
```

Any deferral works — `cb => setImmediate(cb)`, `cb => setTimeout(cb, 0)`,
an idle callback, a test harness's fake clock. The rules:

- The first change of a batch schedules exactly **one slot**; further
  changes ride along until it fires. No matter how many changes arrive,
  the scheduler is invoked once per batch.
- Combined with `throttle`/`debounce`, the timer decides *when* an emit
  becomes due, and the scheduler then aligns the actual emission — e.g.
  `{ debounce: 100, schedule: raf }` means "after 100ms of quiet, emit on
  the next frame".
- [`LazyWatch.flush`](#flushing-pending-changes) still emits synchronously,
  bypassing the scheduler; a slot outlived by a flush, `pause`, or
  `dispose` fires as a harmless no-op (no cancel handle is needed).
- The scheduler should invoke the callback **asynchronously**. Calling it
  synchronously works but emits each change individually — and a listener
  that then mutates state can loop.

## Listening for Changes

```js
const unsubscribe = LazyWatch.on(watchedObject, callback, options);
```

Registers a callback function that will be called with a diff object whenever changes are made to the watched object. Returns an idempotent **unsubscribe function** that removes exactly this registration:

```js
const stop = LazyWatch.on(watched, diff => render(diff));
// later:
stop(); // listener removed; calling stop() again is a harmless no-op
```

**Options** (all optional):
- `once` - Remove the listener after its first invocation
- `signal` - An `AbortSignal` that removes the listener when aborted. An already-aborted signal never adds the listener (matching `addEventListener` semantics)

```js
const controller = new AbortController();
LazyWatch.on(watched, callback, { signal: controller.signal });
// later: removes the listener
controller.abort();
```

### One-shot Listeners

```js
LazyWatch.once(watchedObject, callback, options);
```

Shorthand for `on(..., { once: true })` — the listener is removed after its first invocation. For listeners on nested proxies, "first invocation" means the first batch that actually touches their subtree; unrelated changes don't consume it.

### Nested Proxy Listeners

Listeners can be registered on nested objects or arrays within a watched object. When you register a listener on a nested proxy, it receives **path-relative diffs** - only the changes relevant to that subtree, rather than the full root diff.

**Example:**
```js
const data = new LazyWatch({
  root: {
    count: 1
  }
}, { throttle: 15 });

// Listener on the root proxy receives full diffs
LazyWatch.on(data, change => {
  console.log('Root:', JSON.stringify(change));
  // Logs: Root: {"root":{"count":2}}
});

// Listener on nested proxy receives path-relative diffs
LazyWatch.on(data.root, change => {
  console.log('Nested:', JSON.stringify(change));
  // Logs: Nested: {"count":2}
});

data.root.count++;
```

This feature is particularly useful when:
- You want to listen to changes in specific parts of a large state object
- Different components manage different sections of your application state
- You need granular control over which changes trigger specific handlers

**Multi-level nesting example:**
```js
const app = new LazyWatch({
  user: { name: 'Alice', preferences: { theme: 'dark' } },
  settings: { lang: 'en' }
});

// Only notified when user changes
LazyWatch.on(app.user, changes => {
  console.log('User changes:', changes);
  // Will receive: { name: 'Bob' } or { preferences: { theme: 'light' } }
});

// Only notified when settings change
LazyWatch.on(app.settings, changes => {
  console.log('Settings changes:', changes);
  // Will receive: { lang: 'fr' }
});

app.user.name = 'Bob';      // Only user listener fires
app.settings.lang = 'fr';   // Only settings listener fires
```

**Subtree deletion and replacement:** when the subtree a nested listener is
registered on is deleted — or replaced wholesale by a leaf value (string,
number, boolean, `Date`, ...) — the listener is called with `null` for a
deletion (matching the diff convention where `null` means delete) or with the
new leaf value for a replacement. This also applies when an *ancestor* of the
subtree is deleted or replaced by a leaf: the listener receives `null`.

```js
const app = new LazyWatch({ user: { name: 'Alice' } });

LazyWatch.on(app.user, changes => {
  // { name: 'Bob' }  — normal path-relative diff
  // null             — after `delete app.user`
  // 'offline'        — after `app.user = 'offline'`
});
```

Note that listeners are bound to a *path*, not an object identity: if a new
object is later assigned at the same path, the listener resumes receiving its
diffs.

## Removing Listeners

```js
LazyWatch.off(watchedObject, callback);
```

Removes a previously registered callback function. Registrations are per
proxy: the same function registered on the root and on a nested proxy are
distinct registrations, and `off` removes only the one made on the proxy you
pass. The same applies to `AbortSignal` removal — aborting a signal removes
only the registration it was passed to.

## Flushing Pending Changes

```js
LazyWatch.flush(watchedObject);
```

Synchronously emits any pending changes to all listeners, bypassing microtask
batching, throttle, debounce, and pause state. Does nothing when there are no
pending changes. Useful before serializing state, unloading a page, or any
time you need listeners up to date *now*:

```js
const data = new LazyWatch({ count: 0 }, { debounce: 500 });
LazyWatch.on(data, diff => sendToServer(diff));

data.count = 1;
window.addEventListener('beforeunload', () => {
  LazyWatch.flush(data); // don't lose the last diff to the debounce timer
});
```

## Inspecting Pending Changes

```js
const pending = LazyWatch.getPendingDiff(watchedObject);
```

Returns a deep-cloned copy of the changes accumulated since the last emit,
without consuming them — the batch still emits as usual, and mutating the
returned copy affects nothing. Returns an empty object when nothing is
pending. Useful for debugging what a batch will contain, especially under
`throttle`/`debounce` where changes can sit pending for a while:

```js
const data = new LazyWatch({ count: 0 }, { debounce: 500 });
data.count = 1;
LazyWatch.getPendingDiff(data); // { count: 1 } — not emitted yet
```

## Taking Snapshots

```js
const state = LazyWatch.snapshot(watchedObject);
```

Returns a deep-cloned plain copy of the current state — no proxy, no shared
references. Mutating or serializing the snapshot never affects the watched
object or triggers listeners. Works on the root proxy or any nested proxy
(snapshotting just that subtree):

```js
const app = new LazyWatch({ user: { name: 'Alice' }, count: 0 });

const full = LazyWatch.snapshot(app);        // { user: { name: 'Alice' }, count: 0 }
const sub = LazyWatch.snapshot(app.user);    // { name: 'Alice' }

localStorage.setItem('state', JSON.stringify(full)); // safe to serialize
```

## Pausing and Resuming Event Emissions

```js
LazyWatch.pause(watchedObject);
```

Pauses event emissions. Changes continue to be tracked but listeners won't be notified until `resume()` is called.

```js
LazyWatch.resume(watchedObject);
```

Resumes event emissions. If there are pending changes, they will be emitted immediately.

```js
const isPaused = LazyWatch.isPaused(watchedObject);
```

Returns `true` if the watched object is currently paused, `false` otherwise.

**Example:**
```js
const data = new LazyWatch({ count: 0 });

LazyWatch.on(data, diff => {
  console.log('Changes:', diff);
});

LazyWatch.pause(data);
data.count = 1;
data.count = 2;
data.count = 3;
// No listener notifications while paused

LazyWatch.resume(data);
// Immediately logs: Changes: { count: 3 }
```

## Silent Mutations

```js
const diff = LazyWatch.silent(watchedObject, callback);
```

Executes a callback while suppressing event emissions. Any changes made during the callback are tracked and returned as a diff object. Forces emission of any pending changes before silent execution to ensure a clean slate.

**Parameters:**
- `watchedObject` - The LazyWatch proxy
- `callback` - Function to execute silently

**Returns:**
- A diff object containing changes made during the callback

**Example:**
```js
const data = new LazyWatch({ count: 0, name: '' });

LazyWatch.on(data, diff => {
  console.log('Changes:', diff);
});

// Make silent changes without triggering listeners
const diff = LazyWatch.silent(data, () => {
  data.count = 1;
  data.name = 'test';
});

// diff = { count: 1, name: 'test' }
// No listener was triggered

// Use the returned diff to perform custom operations
console.log('Silent changes:', diff);
```

**Use cases:**
- Initializing state without triggering listeners
- Bulk updates where you want manual control over notifications
- Testing or debugging scenarios where you need to inspect changes without side effects

## Inverse Diffs (Undo)

```js
const watched = new LazyWatch(data, { inverse: true });
```

With the `inverse` option, every batch also records an **inverse diff** — a
patch that undoes the batch. Listeners receive it as a second argument
(path-relative for nested listeners, like the forward diff):

```js
const doc = new LazyWatch({ text: '', cursor: 0 }, { inverse: true });

const undoStack = [];
let undoing = false;

LazyWatch.on(doc, (diff, inverse) => {
  if (!undoing) undoStack.push(inverse);
});

function undo() {
  const inverse = undoStack.pop();
  if (!inverse) return;
  undoing = true;
  try {
    LazyWatch.patch(doc, inverse);
    LazyWatch.flush(doc); // emit synchronously, while the guard is set
  } finally {
    undoing = false;
  }
}

doc.text = 'hello';
doc.cursor = 5;
// ...later:
undo(); // doc is { text: '', cursor: 0 } again
```

The inverse is an ordinary diff: it survives `JSON.stringify`, applies with
`LazyWatch.patch` (locally or on a remote mirror — undo works across the
wire), and follows the null-means-delete convention. It captures the state
from before the *first* change in the batch, so applying it after any number
of changes to the same keys restores the true pre-batch values.

The example above is the manual pattern — useful when you need custom
history handling (remote undo, persistence). For the common local case,
the built-in [undo manager](#undo-manager) packages the stack, the guard,
and redo support.

**Trade-offs:** recording previous values costs extra clones on the write
path, and compact `$splice` recording is disabled — structural array ops
(`splice`/`unshift`/`shift`) fall back to per-index diffs, which are still
correct, just larger.

## Transactions

```js
const result = LazyWatch.transaction(watchedObject, callback);
```

Executes the callback atomically: if it throws, **every change it made is
rolled back and nothing is emitted**; if it succeeds, the changes emit as one
normal batch and the callback's return value is returned.

```js
const account = new LazyWatch({ balance: 500, history: [] });

try {
  LazyWatch.transaction(account, () => {
    account.balance -= 100;
    account.history.push({ amount: -100 });
    validate(account); // throws on insufficient funds, bad state, ...
  });
} catch (e) {
  // account.balance is 500 again, history is empty, listeners heard nothing
}
```

Transactions work on any instance — `{ inverse: true }` is not required
(inverse recording is enabled just for the callback's duration). Pending
changes from before the transaction are flushed first, so the rollback covers
exactly the callback's own changes. The callback must be synchronous, and
transactions cannot be nested. Avoid calling `LazyWatch.flush` inside the
callback: flushed changes are emitted immediately and leave the transaction's
rollback scope.

## Undo Manager

```js
const manager = LazyWatch.createUndoManager(watchedObject, options);
```

Creates an undo/redo manager for a watched instance. Every emitted batch
becomes one undoable step:

```js
const doc = new LazyWatch({ text: '', cursor: 0 });
const manager = LazyWatch.createUndoManager(doc, { limit: 100 });

doc.text = 'hello';
doc.cursor = 5;
// ...after the batch emits:

manager.undo();   // doc is { text: '', cursor: 0 } again
manager.redo();   // doc is { text: 'hello', cursor: 5 } again
manager.canUndo;  // true
manager.canRedo;  // false
```

**Options:**
- `limit` - Maximum undo depth (default: `Infinity`). The oldest step is
  dropped when exceeded.

**The manager:**
- `undo()` / `redo()` - Apply the previous/next step; return `true` if a
  step was applied, `false` when there was nothing to do. Pending
  (not-yet-emitted) changes are flushed first, so with `throttle` or
  `debounce` a just-made change is undoable immediately.
- `canUndo` / `canRedo` - Whether a step is available (pending changes
  count toward `canUndo`).
- `clear()` - Drop all history without touching the state.
- `dispose()` - Detach from the instance and restore its inverse-recording
  setting. Disposing the instance disposes its manager automatically.

Undo and redo apply through the normal patch path and emit to the
instance's other listeners as ordinary batches — **synced mirrors follow
undo history automatically**, with no special handling on the receiving
side. New changes clear the redo stack (standard undo-history semantics),
and a successful `LazyWatch.transaction` forms a single undo step.

The manager works on any instance: `{ inverse: true }` is not required.
Inverse recording is enabled for the manager's lifetime, which carries the
usual costs — extra clones on the write path, compact `$splice` recording
disabled, and listeners receive inverse diffs as a second argument. History
starts at a clean batch boundary (pending changes are flushed on attach,
outside the history), changes made inside `LazyWatch.silent` bypass
emission and are not recorded, and only one manager may exist per instance
at a time (dispose the current one first).

## Applying Changes

`LazyWatch.patch` and `LazyWatch.overwrite` accept **two kinds of target**:

- **A LazyWatch proxy** — root or nested. Changes are applied through the
  tracked write path: the diff is recorded and emitted at the (sub)tree's
  path, so listeners and mirrors receive the full transition. A nested
  proxy patches just its subtree — `LazyWatch.patch(app.user, { name: 'Bob' })`
  emits `{ user: { name: 'Bob' } }`, not a root-level fragment.
- **A normal object or array** — mutated in place with exactly the same
  semantics, but with **no change tracking**: nothing is recorded or
  emitted. This is the receive side for plain mirrors (a Vue `reactive`
  object, a worker-thread copy, a config object). A disposed proxy still
  throws rather than degrading to this mode, and a target that is neither
  a proxy nor a plain container (a `Date`, `Map`, primitive, ...) is
  rejected with a `TypeError`.

Shared applier behavior, both targets: nested objects merge recursively,
`null` (or `undefined`) values delete, objects/arrays from the source are
deep-cloned (never aliased), index-keyed array fragments and `$splice` ops
merge into arrays, a real source array is a wholesale replacement whose
`length` the target adopts, and reserved prototype-polluting keys are
refused. Validation runs before any mutation, so a rejected source leaves
the target untouched.

> `LazyWatch.patchObject` and `LazyWatch.overwriteObject` remain as
> **deprecated aliases** delegating to `patch` and `overwrite` — existing
> code keeps working, but new code should use the unified names.

### Patching

```js
LazyWatch.patch(target, diffObject);
```

Applies changes with **merge semantics**: properties not present in the
diff are preserved.

```js
const data = new LazyWatch({ a: 1, b: 2, c: { d: 3 } });

LazyWatch.patch(data, { a: 10, c: { d: 30, e: 40 } });
// Result: { a: 10, b: 2, c: { d: 30, e: 40 } }
// Note: 'b' is preserved, nested object 'c' is merged

// The same call on a plain object — same merge, no tracking:
const plain = { a: 1, b: 2, c: 3 };
LazyWatch.patch(plain, { b: null, c: 30 });
// plain is now: { a: 1, c: 30 } — null deletes
```

### Overwriting

```js
LazyWatch.overwrite(target, source);
```

Makes the target exactly match `source` — **replacement semantics**, where
`patch` merges: shared properties are updated and properties missing from
`source` (or `null` in it) are **deleted at every level**:

```js
const data = new LazyWatch({ a: 1, b: 2, c: { d: 3 } });

LazyWatch.overwrite(data, { a: 10, e: 5 });
// Result: { a: 10, e: 5 } — b and c are deleted
// Emits:  { a: 10, e: 5, b: null, c: null }
```

Arrays are the exception: their elements are merged by index and never
deleted for being missing, but a shorter source array truncates the target
via its `length`.

Use `overwrite` to force a replica into an authoritative state — applying
a full snapshot on reconnect (see the
[WebSocket example](../EXAMPLES.md#example-3-websocket-mirroring-with-reconnect-resync))
— and `patch` for incremental diffs. On a plain mirror (e.g. a Vue
`reactive` object fed by `patch`, see the
[framework adapters](../EXAMPLES.md#example-7-framework-adapters)), the
same call deletes exactly the drift, at every nesting level:

```js
socket.on('snapshot', data => {
  LazyWatch.overwrite(appState, data); // appState now matches exactly
});
```

## Composing Diffs

```js
const combined = LazyWatch.composeDiffs(older, newer);
```

Collapses two sequential diffs into one equivalent diff: applying the
result with `patch` produces the same state as applying `older` then
`newer`. Pure — neither input is mutated, and the result shares no
references with them. This is the primitive for offline send buffers
(queue diffs while disconnected, send one message on reconnect) and for
coalescing undo steps:

```js
LazyWatch.composeDiffs({ a: 1, c: { x: 1 } }, { b: 2, c: { y: 2 } });
// { a: 1, b: 2, c: { x: 1, y: 2 } }

LazyWatch.composeDiffs({ c: { x: 1 } }, { c: null });
// { c: null } — the newer deletion wins

LazyWatch.composeDiffs(
  { items: { $splice: [[1, 1]], length: 2 } },
  { items: { $splice: [[0, 0, ['a']]], length: 3 } }
);
// { items: { $splice: [[1, 1], [0, 0, ['a']]], length: 3 } } — ops concatenate
```

Composition is not defined for every pair. Two sequences have no
single-diff representation in the wire format, and `composeDiffs` **throws
a `TypeError`** (naming the path) rather than emit a diff that would
corrupt receivers:

- **An object diff following a deletion or leaf write** — sequentially the
  object lands on nothing and becomes the exact new value, but a single
  composed diff would *merge* into the receiver's stale container, leaving
  old keys alive. (Array values escape this: receivers apply
  [real arrays wholesale](#array-diffs-and-shape-drift), so array
  fragments after a deletion revive into real arrays and compose fine.)
- **`$splice` ops following index writes on the same array** — receivers
  apply a fragment's ops before its index keys, which would reorder
  history.

Both cases are detected precisely, so the fallback is simple — catch and
send the pieces separately:

```js
let buffer = null;

LazyWatch.on(watched, diff => {
  if (connected) return send(diff);
  try {
    buffer = buffer ? LazyWatch.composeDiffs(buffer, diff) : diff;
  } catch (e) {
    sendQueue.push(buffer); // this pair can't collapse; flush and restart
    buffer = diff;
  }
});
```

## Identifying and Unwrapping Proxies

```js
LazyWatch.isProxy(value);        // is this a live LazyWatch proxy?
LazyWatch.resolveIfProxy(value); // the raw object underneath, or the input
```

`isProxy` returns `true` when `value` is a LazyWatch proxy — root or
nested — whose instance has not been disposed. `resolveIfProxy` unwraps a
proxy to the raw underlying object; non-proxy values pass through
unchanged. Reads on the raw object skip the proxy machinery entirely,
which can help in hot read-only code — but **writes to it are invisible to
LazyWatch**: nothing is recorded or emitted, and mirrors silently desync.
Treat the result as read-only, or use [`snapshot`](#taking-snapshots) for
a safe independent copy.

```js
const data = new LazyWatch({ user: { name: 'Alice' } });

LazyWatch.isProxy(data);         // true
LazyWatch.isProxy(data.user);    // true — nested proxies count
LazyWatch.isProxy({ name: '' }); // false

const raw = LazyWatch.resolveIfProxy(data.user);
raw.name;         // 'Alice' — plain access, no proxy overhead
raw.name = 'Bob'; // ⚠ untracked: no diff, no emit
```

## Disposing

```js
LazyWatch.dispose(watchedObject);
```

Releases the instance: removes all listeners, cancels any pending emit,
clears internal caches so proxies and targets can be garbage-collected,
and detaches an attached [undo manager](#undo-manager). Disposing twice is
a harmless no-op.

After disposal, static methods on the proxy (`on`, `patch`, `snapshot`,
...) throw an error. The proxy object itself keeps working as a plain
object — reads and writes still reach the underlying target — but changes
no longer reach any listener:

```js
const data = new LazyWatch({ count: 0 });
const stop = LazyWatch.on(data, diff => console.log(diff));

LazyWatch.dispose(data);

data.count = 1;            // works, but no listener will ever fire
LazyWatch.on(data, () => {}); // throws: instance has been disposed
```

Dispose instances you no longer need when their listeners capture other
long-lived objects; the internal caches themselves are weak and don't
block garbage collection.

## Array Diffs and Shape Drift

Array changes are emitted as index-keyed fragments rather than full arrays:

```js
const data = new LazyWatch({ items: ['a'] });
data.items.push('b');
// Emits: { items: { 1: 'b', length: 2 } }
```

Structural mutations — `splice`, `unshift`, and `shift` — are emitted as
compact `$splice` ops instead of re-emitting every shifted index:

```js
const data = new LazyWatch({ items: ['b', 'c'] });
data.items.unshift('a');
// Emits: { items: { $splice: [[0, 0, ['a']]], length: 3 } }
// (not { 0: 'a', 1: 'b', 2: 'c', length: 3 })
```

Each op is `[start, deleteCount, items]`, applied by `patch`/`overwrite`
(on proxies and plain objects alike) **before** the fragment's index keys, so an op followed by index
or nested writes in the same batch stays correct. Consecutive structural ops
in one batch append to the same `$splice` list; if index writes are already
pending on that array when a structural op happens, LazyWatch falls back to
per-index recording for that batch (larger, but always correct). On a
1,000-item array of objects, prepending one item emits ~68 bytes instead of
~34 KB.

Reordering methods — `sort`, `reverse`, and `copyWithin` — are also
intercepted: the final arrangement is computed first, and only the relocated
slots are recorded and emitted (as per-slot content diffs, since element
slots are path-addressed). Sorting an already-sorted array emits nothing,
and a throwing `sort` comparator leaves the array untouched. Comparators
see the raw elements — reads behave exactly as through the proxy — and must
not mutate them.

**Real arrays are wholesale values.** Index-keyed fragments are the *merge*
form; when a diff carries an actual array (as emitted for
`obj.list = [...]` replacements), receivers replace their array outright —
elements included, since a replacement's elements are full values, not
sub-diffs:

```js
const mirror = new LazyWatch({ list: [{ a: 1 }] });
LazyWatch.patch(mirror, { list: [{ b: 2 }] });
mirror.list; // [{ b: 2 }] — not [{ a: 1, b: 2 }]
```

Re-applying an identical array is detected and records nothing, so
bidirectional mirrors can't echo. Deleting a container and recreating it
in the same batch is also safe: the emitted diff records `null` for the
stale keys receivers still hold, so `delete obj.k; obj.k = { b: 2 }`
emits `{ k: { b: 2, a: null } }` and mirrors converge exactly.

Applied to a replica that already has `items` as an array, the fragment merges
in-place. But when replicas disagree about which fields exist — typically after
a schema migration, or with clients running different versions — a fragment can
arrive where there is no array to merge into. `patch` and `overwrite`
detect this case and revive the fragment into a real array instead
of storing it verbatim as a plain object:

```js
const receiver = new LazyWatch({}); // never saw `items` before
LazyWatch.patch(receiver, { items: { 1: 'b', length: 2 } });
Array.isArray(receiver.items); // true — not { 1: 'b', length: 2 }
```

Detection requires the fragment to carry a numeric `length` plus at least one
index key, and only applies where the target has no existing container — an
existing plain object is always merged as an object (target shape wins), and
data like `{ length: 5 }` alone is never converted. Array diffs emitted by this
version always include `length`, so fragments are self-describing on the wire.

For repairing data that older versions stored in the corrupted object form, the
detection and revival helpers are exposed:

```js
LazyWatch.Utils.isArrayDiff({ 0: 'a', length: 1 }); // true
LazyWatch.Utils.reviveArrayDiffs(storedState);      // deep-revives, copy-on-write
```

For best results, keep replicas structurally aligned: initialize new fields
everywhere (e.g. `task.assignees ??= []`) before mutating them.

## Supported Values

Watched state must be JSON-shaped data: plain objects, arrays, and primitives,
plus `Date` and `RegExp` as **leaf values** — they are returned as-is (methods
work normally) and tracked only on wholesale replacement:

```js
const state = new LazyWatch({ when: new Date() });
state.when.setHours(0);      // works, but NOT tracked (in-place mutation)
state.when = new Date();     // tracked — emits { when: Date }
```

Collections that mutate through internal slots — `Map`, `Set`, `WeakMap`,
`WeakSet`, `Promise`, `ArrayBuffer`, and typed arrays — are **rejected with a
`TypeError`** wherever they enter watched state: the constructor, property
assignment, and `patch`/`overwrite`. Their mutations
(`map.set(...)`) bypass the proxy entirely and would silently desync replicas,
and they don't survive JSON serialization anyway — so LazyWatch fails loudly
instead of half-tracking them:

```js
new LazyWatch({ users: new Map() });
// TypeError: LazyWatch cannot track Map at "users": in-place mutations
// bypass the proxy and would silently desync. Use a plain object or array instead.

const state = new LazyWatch({});
state.users = new Map();          // throws TypeError
LazyWatch.patch(state, { ids: new Set() }); // throws TypeError
```

Validation runs before any mutation, so a rejected `patch`/`overwrite` leaves
the watched state untouched. Use plain objects instead of Maps
(`{ [id]: value }`) and arrays instead of Sets.

**Class instances are rejected for the same reason.** Cloning and JSON
strip an instance's prototype, silently turning it into a plain object
with no methods — instead of half-tracking it, LazyWatch throws at every
entry point, naming the class and path:

```js
class Vec { constructor(x) { this.x = x; } mag() { return Math.abs(this.x); } }

const state = new LazyWatch({});
state.v = new Vec(3);
// TypeError: LazyWatch cannot track a Vec instance at "v": its prototype
// and methods are silently lost on clone and sync. Use a plain object,
// or store it under a symbol key for local-only state.
```

Store the instance's *data* as a plain object (`{ x: 3 }`) and keep
behavior in functions, or stash the live instance under a
[symbol key](#supported-values) if it's per-replica state that should
never sync. Null-prototype objects (`Object.create(null)`) are plain data
and remain fully supported.

A few more wire-safety rules, all enforced with a `TypeError` at write time:

- **`NaN` and `±Infinity` are rejected** — JSON serializes them as `null`,
  which receivers would interpret as a deletion, silently desyncing replicas
- **Assigning `undefined` deletes the property** — JSON drops `undefined`
  values entirely, so the assignment is normalized to the null-means-delete
  convention and emitted as `{ prop: null }`
- **`__proto__`, `constructor`, and `prototype` are reserved** — writing them
  would mutate prototypes instead of data. They are rejected on the way into
  watched state, and `patch`/`overwrite` refuse diffs containing
  them, so a malicious or corrupt diff received over the network cannot cause
  prototype pollution
- **`Object.defineProperty` is tracked; everything exotic is rejected** — a
  descriptor whose net effect equals a plain assignment (a data value whose
  property stays enumerable, writable, and configurable; attributes absent
  from the descriptor inherit the live property's) goes through the normal
  tracked write path. Accessors and non-default attributes throw — getters,
  setters, and non-enumerable properties do not survive cloning or sync.
  `Object.setPrototypeOf` to a new prototype throws, and so do
  `Object.freeze`/`seal`/`preventExtensions` — frozen state could not be
  tracked, so LazyWatch refuses up front instead of half-freezing

**Symbol-keyed properties are local-only metadata.** JSON cannot carry symbol
keys, so instead of half-tracking them, LazyWatch treats them as a deliberate
escape hatch: writes are stored on the underlying object but never recorded,
emitted, or synced, and their values are exempt from validation (you may even
stash a `Map` there) and are never proxied:

```js
const state = new LazyWatch({ items: [] });
const CACHE = Symbol('cache');

state[CACHE] = new Map();   // fine — never emitted, never synced
state[CACHE].set('k', 'v'); // methods work; the value is not proxied
```

Use this for per-replica bookkeeping that should never travel with the data.

