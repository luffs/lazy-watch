
import {Utils} from "./utils.js";
import {EventEmitter} from "./event-emitter.js";
import {setImmediatePolyfill} from "./set-immediate-polyfill.js";
import {DiffTracker} from "./diff-tracker.js";
import {ProxyHandler, LAZYWATCH_INSTANCE, PROXY_TARGET} from "./proxy-handler.js";


// main.js - Main LazyWatch class
const context = typeof self === 'undefined'
  ? (typeof global === 'undefined' ? globalThis : global)
  : self;

export const setImmediatePolyfillStatus = setImmediatePolyfill(context);

/**
 * LazyWatch - A reactive proxy-based object change tracker
 *
 * Returns a proxy that can be used directly. Static methods on LazyWatch
 * can be used to add listeners, remove listeners, and dispose.
 *
 * @example
 * const data = { count: 0 };
 * const watched = new LazyWatch(data);
 *
 * LazyWatch.on(watched, (changes) => {
 *   console.log('Changes:', changes);
 * });
 *
 * watched.count = 1; // Triggers listener with { count: 1 }
 *
 * LazyWatch.dispose(watched);
 */
export class LazyWatch {
  #diffTracker;
  #eventEmitter;
  #proxyHandler;
  #proxy;
  #disposed = false;

  static #instances = new WeakMap();

  /**
   * Create a new LazyWatch instance
   * @param {Object|Array} original - The object or array to watch
   * @param {Object} options - Configuration options
   * @param {number} options.throttle - Minimum time in milliseconds between emits (default: 0)
   * @param {number} options.debounce - Time in milliseconds to wait for additional changes before emitting (default: 0)
   * @returns {Proxy} A proxy that tracks changes
   * @throws {TypeError} If original is not an object or array
   */
  constructor(original, options = {}) {
    this.#diffTracker = new DiffTracker();
    this.#eventEmitter = new EventEmitter(this.#diffTracker, context, options);
    this.#proxyHandler = new ProxyHandler(original, this.#diffTracker, this.#eventEmitter);
    this.#proxy = this.#proxyHandler.createRootProxy(this);

    // Store the instance reference so we can access it from the proxy
    LazyWatch.#instances.set(this.#proxy, this);

    // Return the proxy directly
    return this.#proxy;
  }

  /**
   * Get the LazyWatch instance from a watched proxy
   */
  static #getInstance(watched) {
    // Try to get instance from the proxy using our symbol
    try {
      const instance = watched[LAZYWATCH_INSTANCE];
      if (instance) return instance;
    } catch (e) {}

    // Fallback to WeakMap lookup
    const instance = LazyWatch.#instances.get(watched);
    if (!instance) {
      throw new Error('Not a LazyWatch proxy or instance has been disposed');
    }
    return instance;
  }

  /**
   * Add a change listener
   * @param {LazyWatch} watched - The LazyWatch proxy
   * @param {Function} listener - Callback function that receives changes
   */
  static on(watched, listener) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    const path = instance.#proxyHandler.getProxyPath(watched);
    instance.#eventEmitter.on(listener, path);
  }

  /**
   * Remove a change listener
   * @param {LazyWatch} watched - The LazyWatch proxy
   * @param {Function} listener - The listener to remove
   */
  static off(watched, listener) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#eventEmitter.off(listener);
  }

  /**
   * Overwrite the watched object with new values
   * Deletes properties not present in source (unless target is array)
   * @param {LazyWatch} watched - The LazyWatch proxy
   * @param {Object} source - The new values
   */
  static overwrite(watched, source) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#proxyHandler.overwrite(watched, source);
  }

  /**
   * Patch (merge) new values without deleting missing properties
   * @param {LazyWatch} watched - The LazyWatch proxy
   * @param {Object} source - The values to merge
   */
  static patch(watched, source) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#proxyHandler.patch(watched, source);
  }

  /**
   * Resolve a proxy to its original target
   * @param {*} obj - Potentially a proxy object
   * @returns {*} The original target or the input if not a proxy
   */
  static resolveIfProxy(obj) {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    try {
      const target = obj[PROXY_TARGET];
      return target ?? obj;
    } catch (e) {
      return obj;
    }
  }

  /**
   * Get a copy of the current pending diff without consuming it
   * @param {LazyWatch} watched - The LazyWatch proxy
   * @returns {Object} A copy of the pending changes
   */
  static getPendingDiff(watched) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    return instance.#diffTracker.getPendingDiff();
  }

  /**
   * Check if an object is a LazyWatch proxy
   * @param {*} obj - The object to check
   * @returns {boolean} True if the object is a LazyWatch proxy, false otherwise
   */
  static isProxy(obj) {
    if (!obj || typeof obj !== 'object') {
      return false;
    }

    // Try to access the LazyWatch instance via symbol
    try {
      const instance = obj[LAZYWATCH_INSTANCE];
      if (instance instanceof LazyWatch && !instance.#disposed) {
        return true;
      }
    } catch (e) {
      // Accessing the symbol might throw in some edge cases
    }

    // Fallback to WeakMap check (which won't find disposed proxies)
    return LazyWatch.#instances.has(obj);
  }

  /**
   * Pause event emissions
   * Changes continue to be tracked but listeners won't be notified until resumed
   * @param {LazyWatch} watched - The LazyWatch proxy
   */
  static pause(watched) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#eventEmitter.pause();
  }

  /**
   * Resume event emissions
   * If there are pending changes, they will be emitted
   * @param {LazyWatch} watched - The LazyWatch proxy
   */
  static resume(watched) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#eventEmitter.resume();
  }

  /**
   * Check if event emissions are paused
   * @param {LazyWatch} watched - The LazyWatch proxy
   * @returns {boolean} True if paused, false otherwise
   */
  static isPaused(watched) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    return instance.#eventEmitter.isPaused();
  }

  /**
   * Execute a callback while suppressing event emissions
   * Any changes made during the callback are tracked and returned as a diff
   *
   * @param {LazyWatch} watched - The LazyWatch proxy
   * @param {Function} callback - Function to execute silently
   * @returns {Object} A diff object containing any changes made during the callback
   * @throws {Error} If the instance has been disposed
   * @example
   * const diff = LazyWatch.silent(watched, () => {
   *   watched.count = 1;
   *   watched.name = 'test';
   * });
   * // diff = { count: 1, name: 'test' }
   */
  static silent(watched, callback) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#eventEmitter.forceEmit()

    let diff = {}
    try {
      callback()
    } finally {
      diff = instance.#diffTracker.consumeDiff()
    }
    return diff
  }

  /**
   * Clean up resources and remove all listeners
   * @param {LazyWatch} watched - The LazyWatch proxy
   */
  static dispose(watched) {
    const instance = LazyWatch.#getInstance(watched);
    if (instance.#disposed) return;

    instance.#disposed = true;
    instance.#eventEmitter.dispose();
    instance.#proxyHandler.dispose();
    instance.#diffTracker.clear();
    LazyWatch.#instances.delete(watched);
  }

  /**
   * Check if instance has been disposed
   */
  #checkDisposed() {
    if (this.#disposed) {
      throw new Error('LazyWatch instance has been disposed');
    }
  }
}

// Export for backward compatibility
LazyWatch.Utils = Utils;

// Export symbols for advanced usage
export { PROXY_TARGET, LAZYWATCH_INSTANCE };