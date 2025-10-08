
import {Utils} from "./utils.js";
import {EventEmitter} from "./event-emitter.js";
import {setImmediatePolyfill} from "./set-immediate-polyfill.js";
import {DiffTracker} from "./diff-tracker.js";
import {ProxyHandler} from "./proxy-handler.js";


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
   * @returns {Proxy} A proxy that tracks changes
   * @throws {TypeError} If original is not an object or array
   */
  constructor(original) {
    this.#diffTracker = new DiffTracker();
    this.#eventEmitter = new EventEmitter(this.#diffTracker, context);
    this.#proxyHandler = new ProxyHandler(original, this.#diffTracker, this.#eventEmitter);
    this.#proxy = this.#proxyHandler.createRootProxy(this);

    // Store the instance reference so we can access it from the proxy
    LazyWatch.#instances.set(this.#proxy, this);

    // Return the proxy directly
    return this.#proxy;
  }

  /**
   * Get the LazyWatch instance from a proxy
   */
  static #getInstance(proxy) {
    // Try to get instance from the proxy using our symbol
    try {
      const instance = proxy[LAZYWATCH_INSTANCE];
      if (instance) return instance;
    } catch (e) {}

    // Fallback to WeakMap lookup
    const instance = LazyWatch.#instances.get(proxy);
    if (!instance) {
      throw new Error('Not a LazyWatch proxy or instance has been disposed');
    }
    return instance;
  }

  /**
   * Add a change listener
   * @param {Proxy} proxy - The LazyWatch proxy
   * @param {Function} listener - Callback function that receives changes
   */
  static on(proxy, listener) {
    const instance = LazyWatch.#getInstance(proxy);
    instance.#checkDisposed();
    instance.#eventEmitter.on(listener);
  }

  /**
   * Remove a change listener
   * @param {Proxy} proxy - The LazyWatch proxy
   * @param {Function} listener - The listener to remove
   */
  static off(proxy, listener) {
    const instance = LazyWatch.#getInstance(proxy);
    instance.#checkDisposed();
    instance.#eventEmitter.off(listener);
  }

  /**
   * Overwrite the watched object with new values
   * Deletes properties not present in source (unless target is array)
   * @param {Proxy} proxy - The LazyWatch proxy
   * @param {Object} source - The new values
   */
  static overwrite(proxy, source) {
    const instance = LazyWatch.#getInstance(proxy);
    instance.#checkDisposed();
    instance.#proxyHandler.overwrite(proxy, source);
  }

  /**
   * Patch (merge) new values without deleting missing properties
   * @param {Proxy} proxy - The LazyWatch proxy
   * @param {Object} source - The values to merge
   */
  static patch(proxy, source) {
    const instance = LazyWatch.#getInstance(proxy);
    instance.#checkDisposed();
    instance.#proxyHandler.patch(proxy, source);
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
   * Clean up resources and remove all listeners
   * @param {Proxy} proxy - The LazyWatch proxy
   */
  static dispose(proxy) {
    const instance = LazyWatch.#getInstance(proxy);
    if (instance.#disposed) return;

    instance.#disposed = true;
    instance.#eventEmitter.dispose();
    instance.#proxyHandler.dispose();
    instance.#diffTracker.clear();
    LazyWatch.#instances.delete(proxy);
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