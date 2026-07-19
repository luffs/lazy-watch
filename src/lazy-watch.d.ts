// lazy-watch.d.ts - TypeScript definitions for LazyWatch

/**
 * Represents the changes detected by LazyWatch
 * Keys are property names, values are the new values (null for deletions).
 * Array changes appear as index-keyed fragments carrying a numeric `length`,
 * e.g. { 1: 'b', length: 2 }. Structural array mutations (splice, unshift,
 * shift) appear as compact op lists applied before the fragment's index keys:
 * { $splice: [[start, deleteCount, items]], length: n }.
 */
export type ChangeSet = Record<string, any>;

/**
 * Idempotent function that removes exactly the listener registration
 * it was returned for
 */
export type Unsubscribe = () => void;

/**
 * A partial update for T. Values may be `null` to delete the property.
 * Date and RegExp are leaf values (replaced wholesale, never merged), so
 * they appear as themselves rather than being mapped over.
 */
export type Patch<T> = {
    [K in keyof T]?: (T[K] extends Date | RegExp ? T[K]
        : T[K] extends object ? Patch<T[K]>
        : T[K]) | null;
};

/**
 * Callback function for change notifications, typed after the watched
 * object: diffs are `Patch<T>` fragments, so property access on them is
 * checked and autocompleted.
 *
 * Root listeners always receive a diff object. Listeners registered on
 * nested proxies receive path-relative diffs — and when their subtree (or an
 * ancestor of it) is deleted they receive `null` (hence the nullable
 * parameter; narrow before use); when it is replaced wholesale by a leaf
 * value (string, number, boolean, Date, ...) they receive that value
 * directly (cast when handling this case).
 *
 * When the instance was created with `{ inverse: true }` (or has an undo
 * manager attached), listeners receive a second argument: the inverse diff
 * for the same batch (path-relative for nested listeners). Applying it with
 * LazyWatch.patch restores the pre-batch state.
 *
 * Wire-level shapes — index-keyed array fragments and `$splice` op lists —
 * are delivered inside the diff where an array changed; access them by
 * casting the fragment to `ChangeSet` when you need to inspect them.
 *
 * The type parameter defaults to `any` so standalone `ChangeListener`
 * annotations keep working without one.
 */
export type ChangeListener<T extends object = any> = (
    changes: Patch<T> | null,
    inverse?: Patch<T> | null
) => void;

/**
 * Utility functions exposed as `LazyWatch.Utils`
 */
export interface UtilsInterface {
    /**
     * Check if a value is a plain object or array that can be deep-watched.
     * Returns false for Date and RegExp (leaf values — replaced wholesale,
     * never proxied or merged) and for the rejected collection types
     */
    isObjectOrArray(val: any): boolean;

    /**
     * Name of the rejected collection type (Map, Set, WeakMap, WeakSet,
     * Promise, ArrayBuffer, typed arrays), or null if the value is allowed
     * in watched state
     */
    rejectedTypeName(val: any): string | null;

    /**
     * Deep-check a value entering watched state; throws a TypeError naming
     * the offending path if it contains a rejected collection type.
     * Date and RegExp pass as leaf values. Cycle-safe
     */
    assertSupported(value: any, path?: Array<string | number>): void;

    /**
     * True for index-keyed array diff fragments, e.g. { 1: 'b', length: 2 }:
     * a plain object whose keys are all array indices plus a numeric `length`
     */
    isArrayDiff(val: any): boolean;

    /**
     * Return the value with any array-diff-shaped nodes converted into real
     * arrays, recursively. Copy-on-write: containers are copied only where a
     * conversion happens
     */
    reviveArrayDiffs(value: any): any;

    /**
     * Deep clone a value. Uses structuredClone when available and falls back
     * to manual cloning when it is missing or throws (e.g. the value contains
     * a function). The manual path handles plain objects, arrays, Date and
     * RegExp; functions are copied by reference. Cycle-safe
     */
    deepClone<T>(obj: T, hash?: WeakMap<any, any>): T;
}

/**
 * Options for change listeners
 */
export interface ListenerOptions {
    /**
     * Remove the listener after its first invocation. For listeners on
     * nested proxies, "first invocation" means the first batch that
     * actually touches their subtree
     * @default false
     */
    once?: boolean;

    /**
     * Removes the listener when aborted; an already-aborted signal
     * never adds the listener (matching addEventListener semantics)
     */
    signal?: AbortSignal;
}

/**
 * Options for LazyWatch.createUndoManager
 */
export interface UndoManagerOptions {
    /**
     * Maximum undo depth; the oldest step is dropped when exceeded
     * @default Infinity
     */
    limit?: number;
}

/**
 * Undo/redo manager created by LazyWatch.createUndoManager.
 *
 * Each emitted batch is one undoable step. undo() and redo() apply through
 * the instance's normal patch path and emit to other listeners as an
 * ordinary batch, so synced mirrors follow undo history automatically
 */
export interface UndoManager {
    /**
     * Undo the most recent step. Pending (not yet emitted) changes are
     * flushed first so they form the step being undone
     * @returns True if a step was undone, false when there was nothing to
     * undo or the manager is disposed
     */
    undo(): boolean;

    /**
     * Re-apply the most recently undone step. Pending changes are flushed
     * first; being new changes, they clear the redo stack
     * @returns True if a step was re-applied, false otherwise
     */
    redo(): boolean;

    /**
     * True when there is a step to undo. Pending (not yet emitted) changes
     * count, so with throttle/debounce a just-made change is undoable
     * before its timer fires
     */
    readonly canUndo: boolean;

    /**
     * True when there is an undone step to re-apply
     */
    readonly canRedo: boolean;

    /**
     * Drop all undo and redo history without touching the watched state
     */
    clear(): void;

    /**
     * Detach from the instance: stop recording, drop history, and restore
     * the instance's inverse-recording setting. Idempotent
     */
    dispose(): void;
}

/**
 * Configuration options for LazyWatch
 */
export interface LazyWatchConstructorOptions {
    /**
     * Minimum time in milliseconds between emits (throttling)
     * When set, the first change emits immediately, but subsequent changes
     * within the throttle window are batched together
     * @default 0 (no throttling)
     */
    throttle?: number;

    /**
     * Time in milliseconds to wait for additional changes before emitting (debouncing)
     * When set, emits are delayed until no changes occur for the specified duration
     * Each new change resets the debounce timer
     * @default 0 (no debouncing)
     * @note If both throttle and debounce are set, debounce takes precedence
     */
    debounce?: number;

    /**
     * Also record an inverse diff per batch; listeners receive it as a
     * second argument. Applying the inverse with LazyWatch.patch restores
     * the pre-batch state (undo).
     * Costs extra clones on the write path, and disables compact $splice
     * recording — structural array ops (splice/unshift/shift) fall back to
     * per-index diffs, which are still correct, just larger
     * @default false
     */
    inverse?: boolean;
}

/**
 * The LazyWatch constructor and its static API.
 *
 * Declared as an interface with a construct signature (rather than a class)
 * because `new LazyWatch(obj)` returns a proxy typed as the watched object
 * itself, which a class declaration cannot express.
 */
export interface LazyWatchStatic {
    /**
     * Create a new LazyWatch instance
     * Returns a proxy that can be used directly like the original object
     * @param original - The object or array to watch
     * @param options - Configuration options
     * @returns A proxy that tracks changes to the original object
     * @throws {TypeError} If original is not a plain object or array, or
     * contains a rejected collection type (Map, Set, typed arrays, ...)
     *
     * @example
     * const user = { name: 'Alice', age: 30 };
     * const watched = new LazyWatch(user);
     * LazyWatch.on(watched, changes => console.log(changes));
     * watched.age = 31; // Triggers listener
     */
    new <T extends object>(original: T, options?: LazyWatchConstructorOptions): T;

    /**
     * Add a change listener to a LazyWatch proxy
     * Listeners registered on nested proxies receive path-relative diffs;
     * they receive `null` when their subtree (or an ancestor) is deleted,
     * and the new leaf value when the subtree is replaced wholesale
     * @param watched - The LazyWatch proxy (or a nested proxy within it)
     * @param listener - Callback function that receives changes
     * @param options - Listener options (once, AbortSignal)
     * @returns An idempotent unsubscribe function that removes exactly this registration
     * @throws {TypeError} If listener is not a function
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     */
    on<T extends object>(watched: T, listener: ChangeListener<T>, options?: ListenerOptions): Unsubscribe;

    /**
     * Add a change listener that is removed after its first invocation
     * @param watched - The LazyWatch proxy (or a nested proxy within it)
     * @param listener - Callback function that receives changes
     * @param options - Listener options (AbortSignal)
     * @returns An idempotent unsubscribe function that removes exactly this registration
     * @throws {TypeError} If listener is not a function
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     */
    once<T extends object>(watched: T, listener: ChangeListener<T>, options?: Omit<ListenerOptions, 'once'>): Unsubscribe;

    /**
     * Remove a change listener from a LazyWatch proxy
     * Registrations are per proxy: the same function registered on the root
     * and on a nested proxy are distinct, and `off` removes only the
     * registration made on the proxy passed here
     * @param watched - The LazyWatch proxy the listener was registered on
     * @param listener - The listener to remove
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     */
    off<T extends object>(watched: T, listener: ChangeListener<T>): void;

    /**
     * Overwrite the watched object with new values
     * Deletes properties not present in source (unless target is array)
     * @param watched - The LazyWatch proxy
     * @param source - The new values (may be a diff received from a listener)
     * @throws {TypeError} If source is not an object
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     *
     * @example
     * const watched = new LazyWatch({ a: 1, b: 2, c: 3 });
     * LazyWatch.overwrite(watched, { a: 10, d: 4 });
     * // watched is now { a: 10, d: 4 } - b and c are deleted
     */
    overwrite<T extends object>(watched: T, source: Patch<T> | ChangeSet): void;

    /**
     * Patch (merge) new values without deleting missing properties
     * @param watched - The LazyWatch proxy
     * @param source - The values to merge (may be a diff received from a listener)
     * @throws {TypeError} If source is not an object
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     *
     * @example
     * const watched = new LazyWatch({ a: 1, b: 2, c: 3 });
     * LazyWatch.patch(watched, { a: 10, d: 4 });
     * // watched is now { a: 10, b: 2, c: 3, d: 4 } - b and c remain
     */
    patch<T extends object>(watched: T, source: Patch<T> | ChangeSet): void;

    /**
     * Patch (merge) new values into a normal (non-proxy) object without deleting missing properties
     * This utility method applies LazyWatch's patching semantics to regular objects
     * @param target - A normal object or array (not a LazyWatch proxy)
     * @param source - The values to merge into the target
     *
     * @example
     * const normalObj = { a: 1, b: 2, c: { d: 3 } };
     * LazyWatch.patchObject(normalObj, { a: 10, c: { d: 30, e: 40 } });
     * // normalObj is now { a: 10, b: 2, c: { d: 30, e: 40 } }
     *
     * @example
     * // Using null to delete properties
     * const obj = { a: 1, b: 2, c: 3 };
     * LazyWatch.patchObject(obj, { b: null, c: 30 });
     * // obj is now { a: 1, c: 30 }
     */
    patchObject<T extends object>(target: T, source: Patch<T> | ChangeSet): void;

    /**
     * Compose two sequential diffs into one equivalent diff: applying the
     * result with `patch` produces the same state as applying `older` then
     * `newer`. The primitive for offline send buffers (collapse queued
     * diffs into one message) and undo-step coalescing. Pure — neither
     * input is mutated and the result shares no references with them.
     *
     * Two pairings have no single-diff representation and throw a
     * TypeError naming the path: an object diff following a deletion or
     * leaf write, and `$splice` ops following index writes on the same
     * array. Catch the error and fall back to applying the diffs
     * separately, or resync with `snapshot` + `overwrite`
     * @param older - The earlier diff
     * @param newer - The later diff
     * @returns A new diff equivalent to applying both in order
     * @throws {TypeError} If either input is not a diff object, contains
     * unsupported values, or the pair has no single-diff representation
     *
     * @example
     * const one = LazyWatch.composeDiffs({ a: 1 }, { b: 2, a: null });
     * // { a: null, b: 2 }
     */
    composeDiffs(older: ChangeSet, newer: ChangeSet): ChangeSet;

    /**
     * Resolve a proxy to its original target
     * @param obj - Potentially a proxy object
     * @returns The original target or the input if not a proxy
     */
    resolveIfProxy<T>(obj: T): T;

    /**
     * Check if an object is a LazyWatch proxy
     * @param obj - The object to check
     * @returns True if the object is a LazyWatch proxy (and not disposed), false otherwise
     */
    isProxy(obj: any): boolean;

    /**
     * Get a deep-cloned plain snapshot of the current state
     * Works on the root proxy or any nested proxy (snapshotting that subtree).
     * The result shares no references with the watched object, so it can be
     * mutated or serialized freely without affecting tracking
     * @param watched - The LazyWatch proxy (or a nested proxy within it)
     * @returns A deep clone of the underlying data
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     *
     * @example
     * const state = LazyWatch.snapshot(watched);
     * localStorage.setItem('state', JSON.stringify(state));
     */
    snapshot<T extends object>(watched: T): T;

    /**
     * Get a copy of the current pending diff without consuming it
     * Returns a snapshot of pending changes that haven't been emitted yet
     * @param watched - The LazyWatch proxy
     * @returns A copy of the pending changes
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     */
    getPendingDiff(watched: object): ChangeSet;

    /**
     * Synchronously emit any pending changes to all listeners.
     * Bypasses microtask batching, throttle, debounce, and pause state.
     * Does nothing if there are no pending changes
     * @param watched - The LazyWatch proxy
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     */
    flush(watched: object): void;

    /**
     * Pause event emissions
     * Changes continue to be tracked but listeners won't be notified until resumed
     * @param watched - The LazyWatch proxy
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     */
    pause(watched: object): void;

    /**
     * Resume event emissions
     * If there are pending changes, they will be emitted
     * @param watched - The LazyWatch proxy
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     */
    resume(watched: object): void;

    /**
     * Check if event emissions are paused
     * @param watched - The LazyWatch proxy
     * @returns True if paused, false otherwise
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     */
    isPaused(watched: object): boolean;

    /**
     * Execute a callback while suppressing event emissions
     * Any changes made during the callback are tracked and returned as a diff
     * @param watched - The LazyWatch proxy
     * @param callback - Function to execute silently
     * @returns A diff object containing any changes made during the callback
     * @throws {Error} If the instance has been disposed
     *
     * @example
     * const watched = new LazyWatch({ count: 0, name: '' });
     * const diff = LazyWatch.silent(watched, () => {
     *   watched.count = 1;
     *   watched.name = 'test';
     * });
     * // diff = { count: 1, name: 'test' }, no listeners triggered
     */
    silent(watched: object, callback: () => void): ChangeSet;

    /**
     * Execute a callback atomically: if it throws, every change it made to
     * the watched object is rolled back and nothing is emitted; if it
     * succeeds, the changes emit as one normal batch and the callback's
     * return value is returned.
     * Pending changes from before the transaction are flushed first. Works
     * whether or not the instance was created with `{ inverse: true }`.
     * The callback must be synchronous; transactions cannot be nested
     * @param watched - The LazyWatch proxy
     * @param callback - Function whose changes are applied atomically
     * @returns The callback's return value
     * @throws {Error} If the instance has been disposed or a transaction is
     * already active; rethrows whatever the callback throws (after rollback)
     *
     * @example
     * LazyWatch.transaction(watched, () => {
     *   watched.balance -= 100;
     *   applyFees(watched); // if this throws, balance is restored
     * });
     */
    transaction<R>(watched: object, callback: () => R): R;

    /**
     * Create an undo/redo manager for a watched instance.
     * Each emitted batch becomes one undoable step; undo/redo emit to the
     * instance's other listeners as normal batches, so synced mirrors follow
     * undo history automatically. New changes clear the redo stack.
     * Works on any instance: inverse recording is enabled for the manager's
     * lifetime (with its usual costs — extra clones, compact $splice
     * recording disabled, listeners receive inverse diffs) and restored on
     * manager.dispose(). One manager per instance; disposing the instance
     * disposes its manager. Changes made inside LazyWatch.silent bypass
     * emission and are not recorded
     * @param watched - The LazyWatch root proxy (nested proxies throw)
     * @param options - Manager options (limit)
     * @returns The undo manager
     * @throws {Error} If the instance has been disposed, already has an
     * undo manager, or a nested proxy is passed
     *
     * @example
     * const manager = LazyWatch.createUndoManager(watched, { limit: 100 });
     * watched.count = 1;
     * manager.undo(); // count restored
     * manager.redo(); // count is 1 again
     */
    createUndoManager(watched: object, options?: UndoManagerOptions): UndoManager;

    /**
     * Clean up resources and remove all listeners
     * After disposal, static methods on the proxy throw errors
     * @param watched - The LazyWatch proxy
     */
    dispose(watched: object): void;

    /**
     * Utility functions
     */
    Utils: UtilsInterface;
}

/**
 * LazyWatch - A reactive proxy-based object change tracker
 *
 * The constructor returns a Proxy that behaves like the original object
 * but tracks all changes. Use the static methods to interact with the proxy.
 *
 * @example
 * ```typescript
 * interface User {
 *   name: string;
 *   age: number;
 * }
 *
 * const user: User = { name: 'Alice', age: 30 };
 * const watched = new LazyWatch(user); // typed as User
 *
 * LazyWatch.on(watched, (changes) => {
 *   console.log('User changed:', changes);
 * });
 *
 * watched.age = 31; // Triggers listener
 *
 * LazyWatch.dispose(watched);
 * ```
 */
export const LazyWatch: LazyWatchStatic;

/**
 * Symbol used internally to access the proxy target
 */
export const PROXY_TARGET: unique symbol;

/**
 * Symbol used internally to access the LazyWatch instance
 */
export const LAZYWATCH_INSTANCE: unique symbol;
