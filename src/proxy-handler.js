// proxy-handler.js - Handles proxy creation and management
import {Utils} from "./utils.js";

export const PROXY_TARGET = Symbol('LazyWatch.ProxyTarget');
export const LAZYWATCH_INSTANCE = Symbol('LazyWatch.Instance');

export class ProxyHandler {
  #original;
  #cache = new WeakMap();
  #diffTracker;
  #eventEmitter;
  #patchMode = false;

  constructor(original, diffTracker, eventEmitter) {
    if (!original || typeof original !== 'object') {
      throw new TypeError('LazyWatch requires an object or array');
    }
    this.#original = original;
    this.#diffTracker = diffTracker;
    this.#eventEmitter = eventEmitter;
  }

  /**
   * Create the root proxy
   */
  createRootProxy(lazyWatchInstance) {
    const proxy = this.#createProxy(this.#original, [], lazyWatchInstance);
    // Store the target reference using a symbol
    this.#cache.set(proxy, this.#original);
    return proxy;
  }

  /**
   * Create a proxy for an object at a given path
   */
  #createProxy(obj, path, lazyWatchInstance) {
    return new Proxy(obj, {
      get: (target, prop) => {
        // Allow access to the proxy marker
        if (prop === PROXY_TARGET) {
          return target;
        }

        // Allow access to LazyWatch instance methods
        if (prop === LAZYWATCH_INSTANCE) {
          return lazyWatchInstance;
        }

        const value = target[prop];

        if (Utils.isObjectOrArray(value)) {
          // Get proxy from cache, or create and cache it
          let childProxy = this.#cache.get(value);
          if (!childProxy) {
            childProxy = this.#createProxy(value, [...path, prop], lazyWatchInstance);
            this.#cache.set(value, childProxy);
          }
          return childProxy;
        }

        return value;
      },

      set: (target, prop, value, receiver) => {
        // Resolve if value is a proxy
        value = this.resolveIfProxy(value);

        const currentValue = target[prop];
        const currentIsObject = Utils.isObjectOrArray(currentValue);
        const valueIsObject = Utils.isObjectOrArray(value);

        // Handle array length changes
        if (Array.isArray(target) && Array.isArray(value) && prop === 'length') {
          this.#handleArrayLengthChange(target, value, path, receiver);
        }

        // Merge if both are objects
        if (currentIsObject && valueIsObject) {
          this.overwrite(receiver[prop], value);
        } else if (currentValue !== value) {
          this.#recordChange(target, prop, value, path);
        }

        return true;
      },

      deleteProperty: (target, prop) => {
        if (prop in target) {
          const diff = this.#diffTracker.getDiffObject(path);
          diff[prop] = null;
          delete target[prop];
          this.#eventEmitter.scheduleEmit();
        }
        return true;
      }
    });
  }

  /**
   * Handle array length changes
   */
  #handleArrayLengthChange(target, value, path, receiver) {
    const currentLength = target.length;

    if (value.length !== currentLength) {
      // Clean diff object from indices beyond new length
      const diff = this.#diffTracker.getDiffObject([...path]);
      for (const key in diff) {
        if (parseInt(key, 10) >= value.length) {
          delete diff[key];
        }
      }
    }
  }

  /**
   * Record a change in the diff
   */
  #recordChange(target, prop, value, path) {
    const diff = this.#diffTracker.getDiffObject(path);

    // Handle array index updates when length was previously set
    if (typeof diff.length === 'number') {
      const index = parseInt(prop, 10);
      if (!isNaN(index) && diff.length <= index) {
        diff.length = index + 1;
      }
    }

    // Only clone if it's an object/array
    const clonedValue = Utils.isObjectOrArray(value) ? Utils.deepClone(value) : value;
    diff[prop] = clonedValue;
    target[prop] = clonedValue;

    this.#eventEmitter.scheduleEmit();
  }

  /**
   * Overwrite target with source properties
   */
  overwrite(target, source) {
    if (!source || typeof source !== 'object') {
      throw new TypeError('Source must be an object');
    }

    for (const prop in source) {
      if (source[prop] === null) {
        delete target[prop];
      } else if (Utils.isObjectOrArray(target[prop]) && Utils.isObjectOrArray(source[prop])) {
        this.overwrite(target[prop], source[prop]);
      } else {
        // Handle nested nulls
        if (Utils.isObjectOrArray(source[prop])) {
          for (const key in source[prop]) {
            if (source[prop][key] === null) {
              delete source[prop][key];
            }
          }
        }
        target[prop] = source[prop];
      }
    }

    // Delete missing properties (unless in patch mode or target is array)
    if (!this.#patchMode && !Array.isArray(target)) {
      for (const prop in target) {
        if (Object.hasOwnProperty.call(target, prop) &&
          (source[prop] === null || source[prop] === undefined)) {
          delete target[prop];
        }
      }
    }
  }

  /**
   * Patch (merge without deleting missing properties)
   */
  patch(target, source) {
    this.#patchMode = true;
    this.overwrite(target, source);
    this.#patchMode = false;
  }

  /**
   * Resolve a proxy to its original target
   */
  resolveIfProxy(obj) {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    // Try to get the target using our symbol
    try {
      const target = obj[PROXY_TARGET];
      return target ?? obj;
    } catch (e) {
      return obj;
    }
  }

  /**
   * Clean up resources
   */
  dispose() {
    this.#cache = new WeakMap();
  }
}