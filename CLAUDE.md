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
CI (`.github/workflows/test.yml`) runs tests on Node 20/22/24, the TypeScript definition checks, and the full benchmark suite (results appear in the job summary) on every push and pull request.

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
   - Handles `overwrite()` (replace + delete) vs `patch()` (merge only) semantics
   - Uses symbol markers (PROXY_TARGET, LAZYWATCH_INSTANCE) for internal access

3. **DiffTracker** (`src/diff-tracker.js`) - Accumulates changes into nested diff objects
   - Maintains a master diff structure that mirrors the watched object's shape
   - `getDiffObject(path)` returns nested object at given path, creating if needed
   - `consumeDiff()` returns and clears the accumulated changes

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

5. **Utils** (`src/utils.js`) - Helper functions for type checking and cloning
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
- `Utils.assertSupported(value, path)` performs the cycle-safe deep validation and throws naming the offending path; validation runs before any mutation, so rejected operations leave state untouched
- `NaN`/`±Infinity` are rejected (JSON would serialize them as `null` = deletion); assigning `undefined` is normalized to a deletion (emitted as `null`)
- `__proto__`/`constructor`/`prototype` are reserved names: rejected at write time via `Utils.isUnsafeKey`, skipped by the appliers as defense-in-depth, and never proxied by the `get` trap — this blocks prototype pollution from hostile wire diffs
- Deletions applied by `overwrite`/`patch` are recorded in the receiver's own diff so relay chains (A → B → C) propagate them
- Symbol-keyed properties are local-only metadata: stored on the target but never recorded/emitted/synced, exempt from validation (a Map under a symbol key is allowed), and never proxied — a deliberate escape hatch for per-replica bookkeeping

### Array Handling
- Array mutations (push, index writes) are tracked via length and index changes
- `splice`/`unshift`/`shift` are intercepted in the `get` trap and recorded as compact `$splice` ops (`[start, deleteCount, items]` triples) instead of per-index writes; the mutation still executes as the native method through the proxy, because trap-driven slot-merge semantics keep cached child-proxy paths valid — raw splicing would move elements and stale them
- Compact recording requires a clean diff node for that array (only `$splice`/`length` keys); otherwise the op falls back to per-index recording so ordering stays correct. Receivers apply `$splice` before merging a node's other keys
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
