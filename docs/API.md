# LazyWatch API Reference

The complete reference for every LazyWatch API, the diff wire format, and
the supported-value rules. For an overview and quick start, see the
[README](../README.md); for real-world recipes (state management, WebSocket
mirroring, undo/redo, form validation), see [EXAMPLES.md](../EXAMPLES.md).

## Table of Contents

- [Creating Watched Objects](#creating-watched-objects)
  - [With Throttling](#with-throttling) · [With Debouncing](#with-debouncing) · [With a Custom Scheduler](#with-a-custom-scheduler-frame-alignment)
- [Listening for Changes](#listening-for-changes)
  - [One-shot Listeners](#one-shot-listeners) · [Nested Proxy Listeners](#nested-proxy-listeners) · [Changes Made Inside a Listener](#changes-made-inside-a-listener)
- [Removing Listeners](#removing-listeners)
- [Flushing Pending Changes](#flushing-pending-changes)
- [Inspecting Pending Changes](#inspecting-pending-changes)
- [Taking Snapshots](#taking-snapshots)
- [Pausing and Resuming Event Emissions](#pausing-and-resuming-event-emissions)
  - [Batches split off while paused](#batches-split-off-while-paused)
- [Silent Mutations](#silent-mutations)
- [Inverse Diffs (Undo)](#inverse-diffs-undo)
- [Transactions](#transactions)
- [Undo Manager](#undo-manager)
  - [Grouping and coalescing](#grouping-and-coalescing) · [Undo beside remote edits](#undo-beside-remote-edits)
- [Applying Changes](#applying-changes)
  - [Patching](#patching) · [Overwriting](#overwriting) · [Batch metadata and origins](#batch-metadata-and-origins)
- [Composing Diffs](#composing-diffs)
- [Identifying and Unwrapping Proxies](#identifying-and-unwrapping-proxies)
- [Disposing](#disposing)
- [Handles and Detached Proxies](#handles-and-detached-proxies)
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

The callback receives the diff, the [inverse diff](#inverse-diffs-undo)
when inverse recording is on, and the [batch metadata](#batch-metadata-and-origins)
when the batch was tagged (`undefined` otherwise).

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

**Listeners follow their objects.** A listener registered on a nested
proxy listens to that object, not to a path: it receives the object's own
changes wherever the object is. When `splice`, `unshift`, `shift`, `sort`,
or `reverse` moves the object to another index, the listener follows it and
hears nothing about the move itself — the object did not change.

When the object leaves the tree — deleted, replaced (by a leaf, or by a
container of the other kind), truncated away, removed by `splice` or
`shift`, or gone with an ancestor — the listener is called once with
`null`, matching the diff convention where `null` means delete. A new
object later put at the same path is another object, and the listener does
not follow it: register on the new one (or on the parent). If the same
object is put back into the tree (a handle's object reinserted, see
[Handles](#handles-and-detached-proxies)), the listener is called with its
whole value and follows it again.

```js
const app = new LazyWatch({ user: { name: 'Alice' }, todos: [{ id: 1 }, { id: 2 }] });

LazyWatch.on(app.user, changes => {
  // { name: 'Bob' }  — normal path-relative diff
  // null             — after `delete app.user`, or `app.user = 'offline'`
});

LazyWatch.on(app.todos[1], changes => {
  // nothing           — after `app.todos.unshift({ id: 0 })`: id 2 only moved
  // { done: true }    — after `app.todos[2].done = true`: id 2, wherever it is
  // null              — after `app.todos.splice(2, 1)`: id 2 left the tree
});
```

One case delivers a whole value instead of a diff: an object that leaves
the tree and comes back within the same batch. Moved by `splice`, `push`,
`sort`, or `reverse` in a batch that also changed it, it travels whole in
a `$splice` op's items; put back by an assignment (under an object's key,
over a leaf, past an array's end), it is written whole. Either way its
listener gets the object's value, with `null` for every key the batch
deleted from it — merging that into what the listener holds gives the
exact new value. A pure move by an array op still tells the listener
nothing.

Subscribe from a consistent state: a listener added in the middle of a
batch receives that whole batch, including changes already visible on the
proxy when it subscribed (and a compact `$splice` op is not idempotent).
Take a listener's initial snapshot right after `LazyWatch.flush`, or
before making changes.


### Changes Made Inside a Listener

A listener may write to the instance it listens on, and may emit
synchronously while doing so — `LazyWatch.flush`, or `patch`/`overwrite`
with [metadata](#batch-metadata-and-origins), for instance to reject an
edit by applying its inverse. Every listener still receives batches in the
order they were produced: the new batch is consumed at the call (the batch
boundary is where you asked for it) but delivered only after the current
batch has reached every listener, and before the outermost emit returns —
so a `flush` from outside any listener still delivers everything
synchronously.

```js
const doc = new LazyWatch({ x: 1 }, { inverse: true });
const mirror = { x: 1 };

LazyWatch.on(doc, (diff, inverse, meta) => {
  if (!meta && diff.x > 10) LazyWatch.patch(doc, inverse, { origin: 'rejected' });
});
LazyWatch.on(doc, diff => LazyWatch.patch(mirror, diff));

doc.x = 99;
// second listener: { x: 99 }, then { x: 1 } tagged 'rejected'; mirror is { x: 1 }
```

A deferred batch reaches the listeners registered when it was produced,
minus any removed before their turn; `once` listeners fire on the first
batch they receive, and nested listeners only for batches touching their
subtree, as usual. The [undo manager](#undo-manager) records each batch
as it is produced, so `undo()` or `group()` called from a listener sees
current history.

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
batching, throttle, debounce, and pause state (while paused it also delivers,
first, any [batches held](#batches-split-off-while-paused) by earlier
implicit flushes; it does not resume). Does nothing when there are no
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

A second argument tags the batch with [metadata](#batch-metadata-and-origins)
that listeners receive alongside it:

```js
LazyWatch.flush(data, { origin: 'autosave' });
// listeners: (diff, inverse, meta) => meta.origin === 'autosave'
```

Called from inside a listener of the same instance, `flush` still ends the
batch at the call, but the flushed batch is delivered after the batch
currently being delivered — see
[Changes Made Inside a Listener](#changes-made-inside-a-listener).

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

### Batches split off while paused

Some operations end the pending batch before doing their work, so that
their own changes form a batch of their own: `LazyWatch.silent`,
`LazyWatch.transaction`, `patch`/`overwrite` with
[metadata](#batch-metadata-and-origins), `LazyWatch.createUndoManager`, and
the undo manager's `undo()`, `redo()`, and `group()`. While paused they
still split the batch there — the pending changes and the operation's own
changes stay separate batches, each with its metadata — but **hold** the
batches instead of notifying anyone. `resume()` delivers the held batches
synchronously, oldest first, before the changes still pending emit on the
usual schedule; an explicit `LazyWatch.flush` delivers them too (it bypasses
pause by design). Held batches are no longer part of
[`getPendingDiff`](#inspecting-pending-changes), and the undo manager
records them as they are split off, so undo works while paused.

```js
LazyWatch.pause(doc);
doc.title = 'Draft';
LazyWatch.patch(doc, remoteDiff, { origin: 'remote' });
// nothing delivered yet

LazyWatch.resume(doc);
// listeners, synchronously: { title: 'Draft' }, then remoteDiff tagged 'remote'
```

## Silent Mutations

```js
const diff = LazyWatch.silent(watchedObject, callback);
```

Executes a callback while suppressing event emissions. Any changes made during the callback are tracked and returned as a diff object. Pending changes are emitted first as their own batch to ensure a clean slate (held instead while [paused](#batches-split-off-while-paused)).

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

LazyWatch.on(doc, (diff, inverse, meta) => {
  if (meta?.origin !== 'undo') undoStack.push(inverse);
});

function undo() {
  const inverse = undoStack.pop();
  // Applied as its own batch tagged { origin: 'undo' }, which the
  // listener above skips — no guard flag needed
  if (inverse) LazyWatch.patch(doc, inverse, { origin: 'undo' });
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
path. A structural array op is recorded as a `$splice` op both ways: the
inverse carries the op that undoes it (applied before the inverse's index
keys, which name positions as they were before the batch), so undoing a
move moves the elements back rather than rewriting every index.

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

Transactions work on any instance — `{ inverse: true }` is not required.
A rollback puts back the very objects the callback replaced, moved, or
removed, in their places, so handles and listeners on them never notice
the transaction happened. Pending
changes from before the transaction are flushed first, so the rollback covers
exactly the callback's own changes. The callback must be synchronous, and
transactions cannot be nested. An `async` callback (or one returning any
thenable) is refused: it returns at its first `await`, so a later failure
could never be rolled back. The changes it made before returning are rolled
back, a `TypeError` is thrown, and the returned promise gets a no-op
rejection handler so it cannot surface as unhandled — but code after its
first `await` still runs, outside any transaction. Await the async work
first, then apply its result in a synchronous transaction. (The TypeScript
definitions reject such callbacks at compile time.) Avoid calling `LazyWatch.flush` inside the
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
- `coalesce` - Milliseconds (default: 0, disabled): batches arriving
  within this window of the previous one merge into the same undo step.
  See [Grouping and coalescing](#grouping-and-coalescing).
- `record` - `(meta, diff) => boolean`, asked for every batch (default:
  record all). Return `false` for batches that are not this user's edits,
  such as remote diffs applied with `{ origin: 'remote' }` metadata. See
  [Undo beside remote edits](#undo-beside-remote-edits).

**The manager:**
- `undo()` / `redo()` - Apply the previous/next step; return `true` if a
  step was applied, `false` when there was nothing to do. Pending
  (not-yet-emitted) changes are flushed first, so with `throttle` or
  `debounce` a just-made change is undoable immediately.
- `canUndo` / `canRedo` - Whether a step is available (pending changes
  count toward `canUndo`).
- `group(callback)` - Record every batch the callback emits as one step.
- `checkpoint()` - End the current coalescing window ("undo stop").
- `clear()` - Drop all history without touching the state.
- `dispose()` - Detach from the instance and restore its inverse-recording
  setting. Disposing the instance disposes its manager automatically.

Undo and redo apply through the normal patch path and emit to the
instance's other listeners as ordinary batches — **synced mirrors follow
undo history automatically**, with no special handling on the receiving
side — tagged with `{ origin: 'undo' }` / `{ origin: 'redo' }`
[metadata](#batch-metadata-and-origins), so a listener that must treat
history replay differently can. New changes clear the redo stack
(standard undo-history semantics),
and a successful `LazyWatch.transaction` forms a single undo step.

The manager works on any instance: `{ inverse: true }` is not required.
Inverse recording is enabled for the manager's lifetime, which carries the
usual costs — extra clones on the write path, compact `$splice` recording
disabled, and listeners receive inverse diffs as a second argument. History
starts at a clean batch boundary (pending changes are flushed on attach,
outside the history), changes made inside `LazyWatch.silent` bypass
emission and are not recorded (for batches that should stay out of history
prefer the [`record` option](#undo-beside-remote-edits): silent changes
cannot invalidate the steps they conflict with), and only one manager may
exist per instance at a time (dispose the current one first).

### Grouping and coalescing

By default every emitted batch is one undo step — which makes typing in a
bound input produce one step per batch. Two tools merge batches into
coarser steps:

**`manager.group(callback)`** records everything the callback emits as a
single step — for composite operations like "apply template" or "reset
form":

```js
manager.group(() => {
  doc.title = 'Untitled';
  LazyWatch.flush(doc);     // batches inside the group still emit normally
  doc.body = '';
  doc.tags = [];
});
manager.undo(); // reverts all three changes at once
```

Pending changes from before the group are flushed first (forming their own
step), trailing changes join the group, and the callback's return value is
returned. Groups must be synchronous and cannot be nested. `group` is
history bookkeeping, **not** a transaction: if the callback throws, its
already-applied changes stay applied (recorded as one step) and the error
is rethrown — wrap the body in `LazyWatch.transaction` for atomicity.

**`coalesce`** merges by time instead: batches arriving within the window
of the previous one join its step, and the window slides with activity —
a typing burst becomes one step, a pause starts the next:

```js
const manager = LazyWatch.createUndoManager(doc, { coalesce: 500 });
// ...five quick keystroke batches → ONE undo step

input.addEventListener('blur', () => manager.checkpoint());
// checkpoint() ends the window early — the next change starts a new step
```

Merged batches are composed into compact single diffs via the
`composeDiffs` algebra where possible; the rare non-composable pairings
(documented under [Composing Diffs](#composing-diffs)) are kept as
sequential segments inside the step — either way undo/redo replay the step
exactly, applied and emitted to other listeners as one batch.

### Undo beside remote edits

A synced mirror receives batches that are not the local user's edits. Left
alone, the manager would record them as steps — Ctrl+Z would revert a
teammate's change — and hiding them with `LazyWatch.silent` is worse than
it looks: silent changes are invisible to the manager, yet they change the
state its steps describe. Every array node in a recorded step carries the
length it saw, so undoing a field edit after a teammate appended an
element truncates the array back to the old length, deleting the
teammate's element (or, after an insert at the front, one of your own).

The `record` option handles both halves. Tag applied batches with
[metadata](#batch-metadata-and-origins) as usual and decline them:

```js
const mirror = new LazyWatch({ todos: [] });
const manager = LazyWatch.createUndoManager(mirror, {
  record: meta => meta?.origin !== 'remote'
});

ws.onmessage = e => LazyWatch.patch(mirror, JSON.parse(e.data), { origin: 'remote' });
LazyWatch.on(mirror, (diff, inverse, meta) => {
  if (meta?.origin !== 'remote') ws.send(JSON.stringify(diff));
});
```

A declined batch does not become a step, but the manager still compares it
with history. Where the batch changed the *shape* of the state — an
array's length, a container created, deleted, or changed between array and
object — every step whose diff or inverse touches that path is dropped from
both stacks, because applying it would truncate, regrow, or replace what
the remote batch put there. Steps on other paths survive, and the
survivors stay consistent with each other. Field-level remote writes leave
history alone: undoing your own edit to a property a teammate has since
overwritten reverts it to your pre-edit value, the last-writer-wins rule
documented for [inverse diffs](#inverse-diffs-undo).

`record` receives the batch's metadata (`undefined` for ordinary batches)
and its diff, so any convention works — an origin, a user id, a flag on
snapshot batches. A
[snapshot resync](../EXAMPLES.md#example-3-websocket-mirroring-with-reconnect-resync)
applied with `overwrite(mirror, snapshot, { origin: 'remote' })` is
handled the same way: history that predates a reshaped array is dropped,
history elsewhere is kept.

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
merge into arrays, a real source array makes the target array exactly
match it (element-wise on proxies, so only real differences are recorded
and emitted; the target adopts its `length`), and reserved
prototype-polluting keys are refused. Validation runs before any
mutation, so a rejected source leaves the target untouched.

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

Arrays are trimmed via `length` rather than key-by-key: a shorter source
array truncates the target. Elements merge by index with full-value
semantics — keys an object element doesn't carry in the source are
deleted, so the array ends up exactly matching the source — and only real
differences are recorded and emitted (see
[Array diffs](#array-diffs-and-shape-drift)).

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

### Batch metadata and origins

```js
LazyWatch.patch(target, diff, meta);
LazyWatch.overwrite(target, source, meta);
LazyWatch.flush(watched, meta);
```

A third argument (second for `flush`) tags the emitted batch with
**metadata**: an object, by convention `{ origin: ... }`, handed to every
listener as the third argument. On a proxy target, `patch`/`overwrite`
with metadata first emit any changes still batched — untagged, as their
own batch — then apply the source and emit the applied changes
synchronously with the metadata attached, so the tagged batch contains
exactly what the call applied (while paused, both batches are
[held](#batches-split-off-while-paused) until `resume`, still separate).
`flush` tags whatever is pending. Ordinary
microtask-batched changes carry no metadata (`meta` is `undefined`), and
metadata is ignored on plain targets, which emit nothing.

This is what a sync layer needs to tell remote batches from local edits —
the [bidirectional recipe](../EXAMPLES.md#bidirectional-edits) in one
line per direction, with no guard flag:

```js
LazyWatch.on(mirror, (diff, inverse, meta) => {
  if (meta?.origin !== 'remote') ws.send(JSON.stringify(diff));
});

ws.onmessage = e => LazyWatch.patch(mirror, JSON.parse(e.data), { origin: 'remote' });
```

Nested listeners receive the same metadata for the batches that touch
their subtree. The [undo manager](#undo-manager) tags the batches it emits
with `{ origin: 'undo' }` and `{ origin: 'redo' }`, so history replay is
distinguishable from an edit, and its [`record` option](#undo-beside-remote-edits)
reads the same metadata to keep remote batches out of history. Metadata
never travels with the diff — it describes the batch on this instance only.

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
  { items: { $splice: [[1, 1]], $length: 2 } },
  { items: { $splice: [[0, 0, ['a']]], $length: 3 } }
);
// { items: { $splice: [[1, 1], [0, 0, ['a']]], $length: 3 } } — ops concatenate
```

Composition is not defined for every pair. A few sequences have no
single-diff representation in the wire format, and `composeDiffs` **throws
a `TypeError`** (naming the path) rather than emit a diff that would
corrupt receivers:

- **An object diff following a deletion or leaf write** — sequentially the
  object lands on nothing and becomes the exact new value, but a single
  composed diff would *merge* into the receiver's stale container, leaving
  old keys alive. (Array values escape this: receivers apply
  [real arrays wholesale](#array-diffs-and-shape-drift), so array
  fragments after a deletion revive into real arrays and compose fine.)
- **A plain object following an array** (a value or a fragment) — the
  object replaced the array on the sender, but a receiver whose slot never
  became an array (it still holds an object) would merge the composed
  object into it. The same holds for an object written into a slot the
  older diff truncated away.
- **`$splice` ops following index writes on the same array** — receivers
  apply a fragment's ops before its index keys, which would reorder
  history.

Everything else composes — a marked fragment after a plain object becomes
the revived array, and a truncation followed by growth deletes the gap
explicitly. The refusals are detected precisely, so the fallback is simple
— catch and send the pieces separately:

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

## Handles and Detached Proxies

A nested proxy is a handle on an object, as a reference is in plain
JavaScript: `const todo = app.todos[1]` keeps addressing that todo
wherever structural array ops move it.

```js
const app = new LazyWatch({ todos: [{ id: 1 }, { id: 2 }] });

const todo = app.todos[1];     // id 2
app.todos.unshift({ id: 0 });  // id 2 moves to index 2
app.todos.reverse();           // ...and to index 0
todo.done = true;              // marks id 2, wherever it is
```

`splice`, `unshift`, `shift`, `sort`, and `reverse` move the element objects
themselves; everything else keeps an object where it is or copies a value
in (an assigned object is cloned, a container assigned over one of the
same kind merges into it). `copyWithin` copies, and an array with holes is
rearranged index by index, so handles there stay with their index.

What `splice`, `shift`, and `pop` return are the removed elements' own
handles. Putting one back — with `splice`, `unshift`, `push`, or an
assignment where no object stands — puts that same object back rather than
a copy, so the usual move keeps the element and every handle on it:

```js
const [moved] = app.todos.splice(from, 1);   // the element's handle
app.todos.splice(to, 0, moved);              // the same object, at its new place
```

While an object is out of the tree — deleted, replaced by a leaf or a
container of the other kind, truncated away, removed by `splice`/`shift`/`pop`
and not put back — its handle is **detached**. Reads still return the
object's contents, but any tracked write through it — assignment,
`delete`, array methods, `LazyWatch.patch`/`overwrite` entering at it —
throws an `Error` naming where the object was last:

```js
const [first] = app.todos.splice(0, 1);
first.done = true;
// Error: LazyWatch proxy is detached: its object left the watched tree
// (last at "todos.0"). Re-read it from the root proxy, or put it back into
// the tree.
```

Such a write would otherwise mutate an object no replica can see while
recording nothing anyone receives. A new object assigned at the same path
is another object (the new value is a clone); read it from the root again.
Symbol-keyed writes remain allowed, being local-only metadata.

Receivers keep handles too: a mirror applying a diff whose `$splice` ops
take an element out and put the same content back in (a move, as the ops
record it) puts its own object back, so handles and listeners on a mirror
follow moves made by the sender.

## Array Diffs and Shape Drift

Array changes are emitted as index-keyed fragments rather than full arrays:

```js
const data = new LazyWatch({ items: ['a'] });
data.items.push('b');
// Emits: { items: { 1: 'b', $length: 2 } }
```

Structural mutations — `splice`, `unshift`, and `shift` — are emitted as
compact `$splice` ops instead of re-emitting every shifted index:

```js
const data = new LazyWatch({ items: ['b', 'c'] });
data.items.unshift('a');
// Emits: { items: { $splice: [[0, 0, ['a']]], $length: 3 } }
// (not { 0: 'a', 1: 'b', 2: 'c', $length: 3 })
```

Each op is `[start, deleteCount, items]`, applied by `patch`/`overwrite`
(on proxies and plain objects alike) **before** the fragment's index keys.
Consecutive structural ops in one batch append to the same `$splice` list,
and writes made to the array's elements before an op name the index each
element holds after it, so a fragment is always "ops, then index keys".
Elements pushed before an op go into the op list first, as an op of their
own. A handle's object pushed back (or assigned at the array's end) is an
op too, as `splice` would record it, so a move out and back in stays a
move for listeners and receivers alike. On a 1,000-item array of objects,
prepending one item emits ~68 bytes instead of ~34 KB.

`sort` and `reverse` are recorded as ops too: the final order is computed
first, the longest run of elements already in order stays, and the rest
are moved out and back in, so the diff carries only the moved elements and
handles follow them. Sorting an already-sorted array emits nothing, and a
throwing `sort` comparator leaves the array untouched. Comparators see the
raw elements — reads behave exactly as through the proxy — and must not
mutate them. `copyWithin` copies elements, which state holds only by value,
so it writes the copies index by index.

**Real arrays are full values.** Index-keyed fragments are the *merge*
form; when a diff carries an actual array, it means "this slot is now
exactly this array" — elements included, since a full value's elements
are full values too, not sub-diffs:

```js
const mirror = new LazyWatch({ list: [{ a: 1 }] });
LazyWatch.patch(mirror, { list: [{ b: 2 }] });
mirror.list; // [{ b: 2 }] — not [{ a: 1, b: 2 }]
```

Senders rarely put a real array on the wire, though: assigning an array
over an existing array — `obj.list = [...]`, or `overwrite` with a
snapshot containing arrays — is **diffed element-wise** and emitted as a
minimal fragment. Unchanged elements are not re-sent (and keep their
identity locally, so cached child proxies stay valid), changed object
elements merge per key — with keys the new element doesn't carry deleted,
as befits a full value — and length changes ride along:

```js
const data = new LazyWatch({ procs: [{ name: 'api', cpu: 1 }, { name: 'db', cpu: 0 }] });
data.procs = [{ name: 'api', cpu: 2 }, { name: 'db', cpu: 0 }];
// Emits: { procs: { 0: { cpu: 2 }, $length: 2 } } — not the whole array
```

A real array is emitted only when there is no existing array to diff
against: a newly created property, or a leaf/object slot becoming an
array. A receiver applying such a wholesale array over an existing array
converges to exactly the sender's value and re-emits the difference
element-wise downstream, so relay chains stay compact.

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
LazyWatch.patch(receiver, { items: { 1: 'b', $length: 2 } });
Array.isArray(receiver.items); // true — not stored as a plain object
```

Detection keys on the fragment's `$length` marker. Every array node a
sender emits carries it — index writes, structural ops, deletions, and
nodes that only hold a deeper change alike (`{ todos: { 0: { done: true },
$length: 2 } }`) — so array fragments are self-describing on the wire, and
a pure truncation (`{ $length: 1 }`) revives correctly too.

The marker also decides **kind changes**. A plain object *without*
`$length`/`$splice` arriving where the receiver holds an array is not a
fragment but a plain object that replaced the array on the sender
(`state.list = {}`), and replaces it on the receiver too. A marked fragment
arriving where the receiver holds a plain object describes an array the
sender has there, and replaces the object with the revived array. Kind
changes therefore converge in both directions, at every nesting level.

Because `$length` is a [reserved name](#supported-values) that can never
appear in watched state, plain data is never mistaken for a fragment: an
array-like object (`{ 0: 'x', length: 2 }`) is ordinary state, syncs as the
object it is, and its `length` key is just data.

The detection and revival helpers are exposed:

```js
LazyWatch.Utils.isArrayDiff({ 0: 'a', $length: 1 }); // true
LazyWatch.Utils.reviveArrayDiffs(storedState);       // deep-revives, copy-on-write
```

(They speak the current `$length`-marked format. Data corrupted by pre-4.2
versions — fragments stored verbatim as objects — carries the old
`length`-marked form; repair it with a 4.x release before upgrading.)

For best results, keep replicas structurally aligned: initialize new fields
everywhere (e.g. `task.assignees ??= []`) before mutating them. And when a
list of records can be edited from more than one side, consider storing it
as an object keyed by id with a separate order array — see
[Lists as Keyed Maps](../EXAMPLES.md#example-8-lists-as-keyed-maps) — so
diffs address records by identity rather than position.

## Supported Values

Watched state must be JSON-shaped data: plain objects, arrays, strings,
finite numbers, and booleans. Everything JSON cannot carry faithfully is
**rejected with a `TypeError`** at every entry point — the constructor,
property assignment, array methods, and `patch`/`overwrite`/`composeDiffs`
— naming the offending path, because a value that changes shape on the
wire is a silent mirror desync waiting to happen:

| Value | What JSON does to it | Store instead |
|---|---|---|
| `Date` | becomes an ISO string, and the sender itself drifts to a string when the diff echoes back | `date.getTime()` or an ISO string |
| `RegExp` | becomes `{}` | its `source` and `flags` strings |
| `bigint` | `JSON.stringify` throws inside your listener | a string or a number |
| `symbol`, function | dropped | plain data, or a [symbol key](#supported-values) for local-only values |
| `NaN`, `±Infinity` | become `null`, which receivers read as a deletion | a finite sentinel |

```js
const state = new LazyWatch({ when: Date.now() }); // fine — a number

state.when = new Date();
// TypeError: LazyWatch cannot track Date at "when": JSON serializes it as a
// string, so mirrors hold a string where the sender holds a Date and the
// types drift. Store a timestamp (date.getTime()) or an ISO string instead.
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
  convention and emitted as `{ prop: null }`. Inside a value that enters
  state (assigned, inserted by `splice`, `unshift` or `push`, or the
  object a LazyWatch is created on) `undefined` is stored as JSON carries
  it: a key holding it is left out, and an array element holding it (a hole
  spread into a call, say) is `null`, which is what receivers hold
- **Assigning `null` to a key is not a deletion on the sender** —
  `obj.k = null` stores `null`, but the diff carries `{ k: null }`, which
  receivers apply as a deletion: the sender keeps the key and every mirror
  drops it. To remove a key, `delete obj.k` (or assign `undefined`); for
  "no value" that must reach mirrors, store another sentinel. In an array
  the difference does not show, since a hole reads as `null`
- **`__proto__`, `constructor`, and `prototype` are reserved** — writing them
  would mutate prototypes instead of data. They are rejected on the way into
  watched state, and `patch`/`overwrite` refuse diffs containing
  them, so a malicious or corrupt diff received over the network cannot cause
  prototype pollution
- **`$splice` and `$length` are reserved by the wire format** — they mark
  [structural array ops and array lengths](#array-diffs-and-shape-drift), so
  every receiver's applier consumes them on arrays and drops them everywhere
  else. Either key in state would live on the sender and nowhere else, so
  both are rejected at write time. Inside a diff they are of course still
  the format itself — senders emit them and
  `patch`/`overwrite`/`composeDiffs` accept them as always. (Items *inside*
  a `$splice` op are full values entering state, so they are held to the
  state rules even in a diff.) Because the fragment marker is a reserved
  key rather than a data shape, array-like objects such as
  `{ 0: 'x', length: 2 }` are ordinary, syncable state — their `length` is
  just data
- **`Object.defineProperty` is tracked; everything exotic is rejected** — a
  descriptor whose net effect equals a plain assignment (a data value whose
  property stays enumerable, writable, and configurable; attributes absent
  from the descriptor inherit the live property's) goes through the normal
  tracked write path. Accessors and non-default attributes throw — getters,
  setters, and non-enumerable properties do not survive cloning or sync.
  `Object.setPrototypeOf` to a new prototype throws, and so do
  `Object.freeze`/`seal`/`preventExtensions` — frozen state could not be
  tracked, so LazyWatch refuses up front instead of half-freezing
- **The constructor argument must be fully trackable** — LazyWatch keeps
  it by reference (every value entering later is cloned), so a frozen,
  sealed, or non-extensible container anywhere in it, or a property that
  is an accessor or non-enumerable/non-writable/non-configurable, is
  rejected up front with a `TypeError` naming the path. A write to such a
  property would fail natively *after* its diff entry was recorded,
  shipping mirrors a phantom change. Watch an extensible copy (e.g.
  `structuredClone(frozen)`) instead

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

