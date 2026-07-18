// lazy-watch.d.ts - TypeScript definitions for LazyWatch

/**
 * Represents the changes detected by LazyWatch
 * Keys are property names, values are the new values (null for deletions).
 * Array changes appear as index-keyed fragments carrying a numeric `length`,
 * e.g. { 1: 'b', length: 2 }.
 */
export type ChangeSet = Record<string, any>;

/**
 * Callback function for change notifications
 */
export type ChangeListener = (changes: ChangeSet) => void;

/**
 * A partial update for T. Values may be `null` to delete the property.
 */
export type Patch<T> = {
    [K in keyof T]?: (T[K] extends object ? Patch<T[K]> : T[K]) | null;
};

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
     * Deep clone an object with support for various types
     * Uses structuredClone when available, falls back to manual cloning
     */
    deepClone<T>(obj: T, hash?: WeakMap<any, any>): T;
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
     * Listeners registered on nested proxies receive path-relative diffs
     * @param watched - The LazyWatch proxy (or a nested proxy within it)
     * @param listener - Callback function that receives changes
     * @throws {TypeError} If listener is not a function
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     */
    on(watched: object, listener: ChangeListener): void;

    /**
     * Remove a change listener from a LazyWatch proxy
     * @param watched - The LazyWatch proxy
     * @param listener - The listener to remove
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     */
    off(watched: object, listener: ChangeListener): void;

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
     * Get a copy of the current pending diff without consuming it
     * Returns a snapshot of pending changes that haven't been emitted yet
     * @param watched - The LazyWatch proxy
     * @returns A copy of the pending changes
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     */
    getPendingDiff(watched: object): ChangeSet;

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
