# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LazyWatch is a lightweight reactive proxy-based object change tracker for JavaScript. It uses JavaScript Proxies to intercept property access and modifications, batching changes asynchronously to emit diffs. The library is framework-agnostic and works in both Node.js and browsers.

## Development Commands

**Running tests:**
```bash
npm test
```
This executes the test suite in `test/tests.js` using a custom test runner (not Jest). The runner sets a non-zero exit code when any test fails.

**Running benchmarks:**
```bash
npm run benchmark        # full suite (~16s)
npm run benchmark:core   # core performance only
npm run benchmark:memory # memory usage only
```
CI (`.github/workflows/test.yml`) runs tests on Node 22/24/26 and Bun (invoked as `bun ./test/tests.js` — plain `bun test` would run Bun's own test runner instead of this project's), the TypeScript definition checks, and the full benchmark suite (results appear in the job summary) on every push and pull request.

## Configuration Options

LazyWatch accepts an optional second parameter with configuration options:

```javascript
const watched = new LazyWatch(original, {
  throttle: 50,  // Minimum time in ms between emits (default: 0)
  debounce: 100  // Wait for quiet period before emitting (default: 0)
});
```

When `throttle` is set, the EventEmitter implements throttling to reduce emit frequency for high-frequency updates. When `debounce` is set, each new change resets the timer and the diff is emitted once no changes occur for the debounce period. If both are set, `debounce` takes precedence.

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

3. **DiffTracker** (`src/diff-tracker.js`) - Accumulates changes into nested diff objects
   - Maintains a master diff structure that mirrors the watched object's shape
   - `getDiffObject(path)` returns nested object at given path, creating if needed
   - `consumeDiff()` returns and clears the accumulated changes
   - Keeps a per-batch registry of destroyed containers (`recordContainerLoss`/`getContainerLoss`, cleared on `consumeDiff`): when a slot whose container was deleted/leaf-replaced/truncated this batch is recreated as an object, `ProxyHandler.#staleFilledDiffValue` null-fills the recreation's diff (recursively through shared plain-object keys) so receivers delete the stale keys they still hold — the null markers go on the wire only, never into local state (the diff copy diverges from the state copy)
   - When `inverseEnabled` (set by the `inverse` constructor option, or temporarily by `LazyWatch.transaction`), also records a master inverse diff — a patch fragment that undoes the batch. `consumeInverse()` must be consumed in lockstep with `consumeDiff()`. Recording rules: first-write-wins (a key's inverse is its value before the batch's first change), gap-fill (deleting/replacing a container backfills its not-yet-recorded keys from the live value), null-fill (keys a replacement introduces are recorded as `null` so undo deletes them). A recorded leaf/null/wholesale-array entry is complete — recording below it is skipped

4. **EventEmitter** (`src/event-emitter.js`) - Batches and emits change notifications
   - Schedules emission using `queueMicrotask` for async batching
   - Multiple synchronous changes trigger only one listener invocation
   - Error handling prevents one failing listener from affecting others
   - Supports throttling (`options.throttle`) and debouncing (`options.debounce`)
   - Tracks `lastEmitTime` and uses `setTimeout` for delayed emits when throttling or debouncing
   - `on()` returns an idempotent unsubscribe function scoped to that exact registration (a no-op function when the signal is already aborted); `off()` and abort removal are path-scoped, so the same callback on two proxies are distinct registrations
   - Listener options: `{ once }` (removed after first invocation; nested-path listeners only consume on batches touching their subtree) and `{ signal }` (AbortSignal removal, addEventListener semantics)
   - Nested-path listeners receive path-relative diffs; when their subtree (or an ancestor) is deleted they are called with `null`, and when it is replaced wholesale by a leaf value they are called with that value. `#filterDiffByPath` uses `undefined` as the "batch didn't touch this path" sentinel (safe because diffs never store `undefined`)
   - `LazyWatch.flush(watched)` exposes `forceEmit()`: synchronous emit bypassing batching, throttle, debounce, and pause

5. **UndoManager** (`src/undo-manager.js`) - Undo/redo stacks built on inverse diffs
   - Created via `LazyWatch.createUndoManager(watched, { limit })`; one per instance (tracked in a `LazyWatch.#undoManagers` WeakMap), root proxy only, disposed automatically when the instance is disposed
   - Dependency-injected (subscribe/flush/patch/hasPending/onDispose closures built in the static factory), so the class never touches LazyWatch internals directly
   - Records each emitted batch as a `{ diff, inverse }` step; undo applies the inverse, redo the forward diff — both through the normal patch path with a synchronous flush while an `#applying` guard keeps the manager's own listener from recording the application. Other listeners receive it as a normal batch (mirrors follow undo)
   - `undo()`/`redo()` flush pending changes first (pending counts toward `canUndo`); new changes clear the redo stack
   - Attach flushes pending changes (kept out of history), then enables `inverseEnabled` for the manager's lifetime; `dispose()` restores the prior setting (discarding a half-recorded inverse when the instance had it off)

6. **diff-compose** (`src/diff-compose.js`) - Pure composition of sequential diffs, exposed as `LazyWatch.composeDiffs(older, newer)`
   - Contract: `patch(S, compose(a, b))` ≡ `patch(patch(S, a), b)` for receivers the pair itself would converge; output shares no references with inputs
   - Newer wins per key (`null`/leaf/wholesale-array outright; object fragments merge recursively); `$splice` lists concatenate; a fragment over a wholesale array value is materialized via an injected `applyFragment` (LazyWatch's `#patchObjectInto`)
   - Throws TypeError (path-named) on the two un-composable pairings: object diff over a deletion/leaf (single diff would merge into receivers' stale container — verified desync), and `$splice` ops after index writes (receivers apply ops before index keys). Array fragments over a deletion escape via `reviveArrayDiffs` (self-describing `length`); a pure-op older fragment's interim `length` is dropped when newer ops follow

7. **Utils** (`src/utils.js`) - Helper functions for type checking and cloning
   - `isObjectOrArray()` determines if value should be proxied; returns false for leaf values
   - `deepClone()` creates copies of objects/arrays for diff storage; uses `structuredClone` when available, with a manual fallback covering only what watched state allows (plain objects, arrays, Date, RegExp; functions by reference). Also backs `LazyWatch.snapshot(watched)`, which returns an independent plain clone of the root or a nested subtree

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

### Static Methods for Normal Objects
LazyWatch provides utility methods that work on normal objects (non-proxies):
- `LazyWatch.patchObject(target, source)` - Merges source into target object without change tracking
  - Recursively merges nested objects
  - Deletes properties when source value is `null`
  - Deep clones objects/arrays to prevent reference sharing
  - Does not delete missing properties (merge semantics, like `patch()`)
  - Use case: Applying LazyWatch's patching logic to regular objects

### Delete Semantics
- Property deletion is represented as `null` in diffs (not `undefined`)
- `overwrite()` deletes properties missing from source (except on arrays)
- `patch()` never deletes properties (only works with LazyWatch proxies)
- `patchObject()` is a static method for patching normal objects (non-proxies) with the same merge semantics as `patch()`

### Supported Values
- Only plain objects and arrays are deep-watched; the root must be one
- Date and RegExp are leaf values: returned as-is from the `get` trap (methods work), but in-place mutations are not tracked — only wholesale property replacement emits a diff
- Map, Set, WeakMap, WeakSet, Promise, ArrayBuffer, and typed arrays are rejected with a TypeError at every entry point (constructor, `set` trap, `overwrite`/`patch`/`patchObject`) — their internal-slot mutations bypass the proxy and would silently desync replicas
- Class instances (any non-plain object) are rejected the same way: cloning and JSON strip their prototype, silently losing methods. `Utils.isPlainObject` accepts prototypes that are null or one step from null (covers `Object.create(null)` and cross-realm plain objects); the symbol-key escape hatch still allows instances as local-only values
- `Utils.assertSupported(value, path)` performs the cycle-safe deep validation and throws naming the offending path; validation runs before any mutation, so rejected operations leave state untouched
- `NaN`/`±Infinity` are rejected (JSON would serialize them as `null` = deletion); assigning `undefined` is normalized to a deletion (emitted as `null`)
- `__proto__`/`constructor`/`prototype` are reserved names: rejected at write time via `Utils.isUnsafeKey`, skipped by the appliers as defense-in-depth, and never proxied by the `get` trap — this blocks prototype pollution from hostile wire diffs
- Deletions applied by `overwrite`/`patch` are recorded in the receiver's own diff so relay chains (A → B → C) propagate them
- Symbol-keyed properties are local-only metadata: stored on the target but never recorded/emitted/synced, exempt from validation (a Map under a symbol key is allowed), and never proxied — a deliberate escape hatch for per-replica bookkeeping

### Inverse Diffs and Transactions
- `new LazyWatch(obj, { inverse: true })` records an inverse diff per batch; listeners receive it as a second argument (path-relative for nested listeners, filtered like the forward diff). Applying it with `patch` restores the pre-batch state; it survives JSON round-trips, so undo works on remote mirrors
- Inverse tracking disables compact `$splice` recording: a `$splice` op cannot be correctly interleaved with per-key inverse entries (receivers apply `$splice` before a node's other keys, breaking chronological undo ordering), so structural array ops fall back to per-index trap recording — correct, just larger
- `LazyWatch.transaction(watched, cb)` works on any instance: it flushes pending changes, enables inverse recording for the callback's duration, and on throw applies the inverse via `ProxyHandler.rollback()` (suppressed — records and emits nothing) and discards the forward diff. Synchronous callbacks only; nesting throws; `flush` inside the callback escapes the rollback scope
- `ProxyHandler.#inverseActive()` gates all capture sites (`recordChange`, both delete paths, truncation, the `overwrite` applier branches); suppression covers structural-op internals and rollback itself
- `LazyWatch.createUndoManager(watched, { limit })` layers undo/redo stacks on top of inverse diffs (see the UndoManager component above); `LazyWatch.silent` changes bypass emission and are never recorded as steps

### Array Handling
- Real arrays in diffs are wholesale values (fragments are the merge form): the appliers replace them outright rather than merging elements — including elements inside them, which are full values too. Null markers inside are dropped during the write (`Utils.cloneWithoutNulls`), which is how inverse-diff arrays encode deletions; a deep-equal re-application records and emits nothing (echo stability, `Utils.deepEqual`)
- Array mutations (push, index writes) are tracked via length and index changes
- `splice`/`unshift`/`shift` are intercepted in the `get` trap and recorded as compact `$splice` ops (`[start, deleteCount, items]` triples) instead of per-index writes; the mutation still executes as the native method through the proxy, because trap-driven slot-merge semantics keep cached child-proxy paths valid — raw splicing would move elements and stale them
- Compact recording requires a clean diff node for that array (only `$splice`/`length` keys); otherwise the op falls back to per-index recording so ordering stays correct. Receivers apply `$splice` before merging a node's other keys
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

Tests use a custom test runner (`TestRunner` class in `test/tests.js`), not Jest:
- Tests are async-aware (uses `await` for microtask batching)
- Custom assertion functions: `assertEquals()`, `assertObjectEqual()`
- Single test file covers all functionality

**Type checking:**
```bash
npm run test:types
```
Compiles `test/types.test.ts` against `src/lazy-watch.d.ts` (never executed; uses `@ts-expect-error` to assert invalid usage is rejected). Note: `LazyWatch` is declared in the `.d.ts` as a const with a construct signature (`LazyWatchStatic` interface), not a class, because the constructor returns a proxy typed as the watched object itself.
