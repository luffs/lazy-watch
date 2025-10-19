// lazy-watch.d.ts - TypeScript definitions for LazyWatch

/**
 * Represents the changes detected by LazyWatch
 * Keys are property paths, values are the new values (null for deletions)
 */
export type ChangeSet = Record<string, any>;

/**
 * Callback function for change notifications
 */
export type ChangeListener = (changes: ChangeSet) => void;

/**
 * Utility functions used by LazyWatch
 */
export interface UtilsInterface {
    /**
     * Check if a value is an object or array (excluding Date)
     */
    isObjectOrArray(val: any): boolean;

    /**
     * Deep clone an object with support for various types
     * Uses structuredClone when available, falls back to manual cloning
     */
    deepClone<T>(obj: T, hash?: WeakMap<any, any>): T;
}

/**
 * Status of the setImmediate polyfill
 */
export interface SetImmediatePolyfillStatus {
    /**
     * Whether setImmediate was polyfilled (true) or native (false)
     */
    polyfilled: boolean;
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
}

/**
 * LazyWatch - A reactive proxy-based object change tracker
 *
 * The constructor returns a Proxy that behaves like the original object
 * but tracks all changes. Use static methods to interact with the proxy.
 *
 * @template T - The type of the object being watched
 *
 * @example
 * ```typescript
 * interface User {
 *   name: string;
 *   age: number;
 * }
 *
 * const user: User = { name: 'Alice', age: 30 };
 * const watched = new LazyWatch(user);
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
export class LazyWatch<T extends object = any> {

    /**
     * Create a new LazyWatch instance
     * Returns a proxy that can be used directly like the original object
     * @param original - The object or array to watch
     * @param options - Configuration options
     * @returns A proxy that tracks changes to the original object
     * @throws {TypeError} If original is not an object or array
     */
    // @ts-ignore
    constructor(original: T, options?: LazyWatchConstructorOptions): T;

    /**
     * Add a change listener to a LazyWatch proxy
     * @param proxy - The LazyWatch proxy returned from the constructor
     * @param listener - Callback function that receives changes
     * @throws {TypeError} If listener is not a function
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     *
     * @example
     * const watched = new LazyWatch({ count: 0 });
     * LazyWatch.on(watched, (changes) => {
     *   console.log('Changes:', changes);
     * });
     */
    static on<T extends object>(proxy: T, listener: ChangeListener): void;

    /**
     * Remove a change listener from a LazyWatch proxy
     * @param proxy - The LazyWatch proxy
     * @param listener - The listener to remove
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     *
     * @example
     * const listener = (changes) => console.log(changes);
     * LazyWatch.on(watched, listener);
     * LazyWatch.off(watched, listener);
     */
    static off<T extends object>(proxy: T, listener: ChangeListener): void;

    /**
     * Overwrite the watched object with new values
     * Deletes properties not present in source (unless target is array)
     * @param proxy - The LazyWatch proxy
     * @param source - The new values
     * @throws {TypeError} If source is not an object
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     *
     * @example
     * const watched = new LazyWatch({ a: 1, b: 2, c: 3 });
     * LazyWatch.overwrite(watched, { a: 10, d: 4 });
     * // watched is now { a: 10, d: 4 } - b and c are deleted
     */
    static overwrite<T extends object>(proxy: T, source: Partial<T>): void;

    /**
     * Patch (merge) new values without deleting missing properties
     * @param proxy - The LazyWatch proxy
     * @param source - The values to merge
     * @throws {TypeError} If source is not an object
     * @throws {Error} If the proxy is not a LazyWatch instance or has been disposed
     *
     * @example
     * const watched = new LazyWatch({ a: 1, b: 2, c: 3 });
     * LazyWatch.patch(watched, { a: 10, d: 4 });
     * // watched is now { a: 10, b: 2, c: 3, d: 4 } - b and c remain
     */
    static patch<T extends object>(proxy: T, source: Partial<T>): void;

    /**
     * Resolve a proxy to its original target
     * @param obj - Potentially a proxy object
     * @returns The original target or the input if not a proxy
     *
     * @example
     * const original = { count: 0 };
     * const watched = new LazyWatch(original);
     * const resolved = LazyWatch.resolveIfProxy(watched);
     * // resolved === original
     */
    static resolveIfProxy<T>(obj: T): T;

    /**
     * Clean up resources and remove all listeners
     * After disposal, the proxy cannot be used anymore
     * @param proxy - The LazyWatch proxy
     *
     * @example
     * const watched = new LazyWatch({ count: 0 });
     * // ... use watched ...
     * LazyWatch.dispose(watched);
     */
    static dispose<T extends object>(proxy: T): void;

    /**
     * Utility functions
     */
    static Utils: UtilsInterface;
}

/**
 * Status of the setImmediate polyfill
 */
export const setImmediatePolyfillStatus: SetImmediatePolyfillStatus;

/**
 * Utility functions
 */
export const Utils: UtilsInterface;

/**
 * Symbol used internally to access the proxy target
 */
export const PROXY_TARGET: symbol;

/**
 * Symbol used internally to access the LazyWatch instance
 */
export const LAZYWATCH_INSTANCE: symbol;

/**
 * DiffTracker - Handles diff tracking internally
 * Not exposed in public API but included for completeness
 */
export class DiffTracker {
    constructor();
    getDiffObject(path?: string[]): Record<string, any>;
    consumeDiff(): ChangeSet;
    hasPendingChanges(): boolean;
    clear(): void;
}

/**
 * EventEmitter - Handles event emission with batching
 * Not exposed in public API but included for completeness
 */
export class EventEmitter {
    constructor(diffTracker: DiffTracker, context: any, options?: LazyWatchConstructorOptions);
    on(listener: ChangeListener): void;
    off(listener: ChangeListener): void;
    scheduleEmit(): void;
    dispose(): void;
}

/**
 * ProxyHandler - Handles proxy creation and management
 * Not exposed in public API but included for completeness
 */
export class ProxyHandler {
    constructor(original: any, diffTracker: DiffTracker, eventEmitter: EventEmitter);
    createRootProxy(lazyWatchInstance: any): any;
    overwrite(target: any, source: any): void;
    patch(target: any, source: any): void;
    resolveIfProxy(obj: any): any;
    dispose(): void;
}

/**
 * Polyfill for setImmediate
 * @param context - The global context to add setImmediate to
 * @returns Status object indicating if polyfill was applied
 */
export function setImmediatePolyfill(context: any): SetImmediatePolyfillStatus;

// Type helpers for better IntelliSense

/**
 * Extract the proxy type with proper nested tracking
 */
export type WatchedProxy<T> = T extends object ? {
    [K in keyof T]: T[K] extends object ? WatchedProxy<T[K]> : T[K];
} : T;


// Augment global context with setImmediate types if needed
declare global {
    interface Window {
        setImmediate(callback: (...args: any[]) => void, ...args: any[]): number;
        clearImmediate(id: number): void;
    }

    interface Global {
        setImmediate(callback: (...args: any[]) => void, ...args: any[]): number;
        clearImmediate(id: number): void;
    }
}