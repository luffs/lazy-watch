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

        // When assigning a new array to a property, treat it as replacement not merge
        const isArrayReplacement = Array.isArray(currentValue) && Array.isArray(value) && currentValue !== value;

        // Merge if both are objects (but not array replacement)
        if (currentIsObject && valueIsObject && !isArrayReplacement) {
          this.overwrite(receiver[prop], value, [...path, prop]);
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
   * @param {Object} target - The target object (or proxy)
   * @param {Object} source - The source object with new values
   * @param {Array} path - The path to the current object (defaults to [] for root)
   */
  overwrite(target, source, path = []) {
    if (!source || typeof source !== 'object') {
      throw new TypeError('Source must be an object');
    }

    // Get the target object (resolve proxy if needed)
    const rawTarget = this.resolveIfProxy(target);
    const rawSource = this.resolveIfProxy(source);
    let diff = null; // Lazy initialization
    let hasChanges = false;

    // Helper to get diff object only when needed
    const getDiff = () => {
      if (!diff) {
        diff = this.#diffTracker.getDiffObject(path);
      }
      return diff;
    };

    // Track array length changes
    if (Array.isArray(rawTarget) && Array.isArray(rawSource) && rawTarget.length !== rawSource.length) {
      getDiff().length = rawSource.length;
      hasChanges = true;
    }

    for (const prop in rawSource) {
      if (rawSource[prop] === null) {
        delete rawTarget[prop];
      } else if (Utils.isObjectOrArray(rawTarget[prop]) && Utils.isObjectOrArray(rawSource[prop])) {
        this.overwrite(rawTarget[prop], rawSource[prop], [...path, prop]);
      } else if (rawTarget[prop] !== rawSource[prop]) {
        // Handle nested nulls
        if (Utils.isObjectOrArray(rawSource[prop])) {
          for (const key in rawSource[prop]) {
            if (rawSource[prop][key] === null) {
              delete rawSource[prop][key];
            }
          }
        }
        // Record the change in diff
        const clonedValue = Utils.isObjectOrArray(rawSource[prop]) ? Utils.deepClone(rawSource[prop]) : rawSource[prop];
        getDiff()[prop] = clonedValue;
        rawTarget[prop] = clonedValue;
        hasChanges = true;
      }
    }

    // Delete missing properties (unless in patch mode or target is array)
    if (!this.#patchMode && !Array.isArray(rawTarget)) {
      for (const prop in rawTarget) {
        if (Object.hasOwnProperty.call(rawTarget, prop) &&
          (rawSource[prop] === null || rawSource[prop] === undefined)) {
          // Track deletion in diff
          getDiff()[prop] = null;
          delete rawTarget[prop];
          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      this.#eventEmitter.scheduleEmit();
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