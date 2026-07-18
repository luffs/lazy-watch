// proxy-handler.js - Handles proxy creation and management
import {Utils} from "./utils.js";

export const PROXY_TARGET = Symbol('LazyWatch.ProxyTarget');
export const LAZYWATCH_INSTANCE = Symbol('LazyWatch.Instance');

// Array methods whose per-index trap writes are collapsed into compact
// `$splice` diff ops. push/pop are already cheap (tail-only) and stay as-is.
const STRUCTURAL_ARRAY_METHODS = new Set(['splice', 'unshift', 'shift']);

export class ProxyHandler {
  #original;
  // Raw target object -> its proxy. Ensures each object in the tree gets
  // exactly one proxy, so identity checks and cached paths stay stable.
  #proxies = new WeakMap();
  // Proxy -> its path from the root, for path-relative listeners
  #proxyPaths = new WeakMap();
  #diffTracker;
  #eventEmitter;
  #patchMode = false;
  #instance = null;
  #suppress = false;

  constructor(original, diffTracker, eventEmitter) {
    if (!Utils.isObjectOrArray(original)) {
      throw new TypeError('LazyWatch requires a plain object or array (Map, Set, Date, etc. cannot be deep-watched)');
    }
    Utils.assertSupported(original);
    this.#original = original;
    this.#diffTracker = diffTracker;
    this.#eventEmitter = eventEmitter;
  }

  /**
   * Create the root proxy
   */
  createRootProxy(lazyWatchInstance) {
    this.#instance = lazyWatchInstance;
    const proxy = this.#createProxy(this.#original, [], lazyWatchInstance);
    this.#proxies.set(this.#original, proxy);
    this.#proxyPaths.set(proxy, []);
    return proxy;
  }

  /**
   * Create a proxy for an object at a given path
   */
  #createProxy(obj, path, lazyWatchInstance) {
    return new Proxy(obj, {
      get: (target, prop, receiver) => {
        // Allow access to the proxy marker
        if (prop === PROXY_TARGET) {
          return target;
        }

        // Allow access to LazyWatch instance methods
        if (prop === LAZYWATCH_INSTANCE) {
          return lazyWatchInstance;
        }

        // Other symbol-keyed values are local-only metadata: returned raw,
        // never proxied or tracked
        if (typeof prop === 'symbol') {
          return target[prop];
        }

        const value = target[prop];

        // Reserved names resolve to prototype machinery — never proxy them
        if (Utils.isUnsafeKey(prop)) {
          return value;
        }

        // Intercept structural array methods to record compact $splice ops
        if (Array.isArray(target) && STRUCTURAL_ARRAY_METHODS.has(prop) &&
          value === Array.prototype[prop]) {
          return (...args) => this.#structuralArrayOp(target, prop, args, path, receiver);
        }

        if (Utils.isObjectOrArray(value)) {
          // Get proxy from cache, or create and cache it
          let childProxy = this.#proxies.get(value);
          if (!childProxy) {
            const childPath = [...path, prop];
            childProxy = this.#createProxy(value, childPath, lazyWatchInstance);
            this.#proxies.set(value, childProxy);
            this.#proxyPaths.set(childProxy, childPath);
          }
          return childProxy;
        }

        return value;
      },

      set: (target, prop, value, receiver) => {
        // Symbol-keyed properties are local-only metadata: stored on the
        // target but never recorded, emitted, or synced (JSON cannot carry
        // them anyway). They are also exempt from value validation, since
        // their values never reach the wire.
        if (typeof prop === 'symbol') {
          target[prop] = this.resolveIfProxy(value);
          return true;
        }

        // Assigning these would mutate prototypes, not data
        if (Utils.isUnsafeKey(prop)) {
          throw new TypeError(
            `LazyWatch cannot set reserved property name "${prop}": it collides with the prototype machinery.`
          );
        }

        // Resolve if value is a proxy
        value = this.resolveIfProxy(value);

        // Reject Map/Set/typed arrays, non-finite numbers, and reserved
        // names anywhere in the assigned value. Guarded so plain primitive
        // writes skip the validation call and its path allocation entirely.
        if ((value !== null && typeof value === 'object') ||
          (typeof value === 'number' && !Number.isFinite(value))) {
          Utils.assertSupported(value, [...path, prop]);
        }

        // Assigning undefined would silently vanish from JSON diffs on the
        // wire; treat it as a deletion to match the null-means-delete
        // convention. (Array length falls through to the native error.)
        if (value === undefined && !(Array.isArray(target) && prop === 'length')) {
          if (prop in target) {
            const diff = this.#diff(path);
            diff[prop] = null;
            delete target[prop];
            this.#scheduleEmit();
          }
          return true;
        }

        const currentValue = target[prop];
        const currentIsObject = Utils.isObjectOrArray(currentValue);
        const valueIsObject = Utils.isObjectOrArray(value);

        // Trim stale diff indices when an array is truncated
        if (Array.isArray(target) && prop === 'length' && typeof value === 'number') {
          this.#handleArrayLengthChange(target, value, path);
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
        // Symbol-keyed properties are local-only: deleted without recording
        if (typeof prop === 'symbol') {
          delete target[prop];
          return true;
        }

        if (prop in target) {
          const diff = this.#diff(path);
          diff[prop] = null;
          delete target[prop];
          this.#scheduleEmit();
        }
        return true;
      }
    });
  }

  /**
   * Diff node for a path; during suppressed structural ops, recording is
   * redirected to a throwaway object so the mutation still happens but
   * leaves no per-index entries behind.
   */
  #diff(path) {
    return this.#suppress ? {} : this.#diffTracker.getDiffObject(path);
  }

  #scheduleEmit() {
    if (!this.#suppress) this.#eventEmitter.scheduleEmit();
  }

  /**
   * Intercepted splice/unshift/shift on a watched array.
   *
   * Records a single compact `$splice` op instead of per-index writes when
   * the array's diff node is clean; otherwise falls back to plain
   * trap-driven recording (correct, just larger). The mutation itself
   * always runs as the native method through the proxy, because the
   * trap-driven slot-merge semantics is what keeps cached child-proxy
   * paths valid — raw splicing would move elements and stale them.
   */
  #structuralArrayOp(target, method, args, path, receiver) {
    const native = Array.prototype[method];
    const len = target.length;

    // Normalize the call into one splice op: [start, deleteCount, items]
    let start = 0;
    let deleteCount = 0;
    let items = [];
    if (method === 'unshift') {
      items = args;
    } else if (method === 'shift') {
      deleteCount = Math.min(1, len);
    } else { // splice
      const rel = args.length ? Math.trunc(args[0]) || 0 : 0;
      start = rel < 0 ? Math.max(len + rel, 0) : Math.min(rel, len);
      if (args.length === 1) {
        deleteCount = len - start;
      } else if (args.length > 1) {
        deleteCount = Math.min(Math.max(Math.trunc(args[1]) || 0, 0), len - start);
      }
      items = args.slice(2);
    }
    items = items.map(item => this.resolveIfProxy(item));

    // No mutation: run the method only for its return value
    if (deleteCount === 0 && items.length === 0) {
      return native.apply(receiver, args);
    }

    // Compact recording is only safe when the array's diff node carries no
    // pending index/nested changes: receivers apply $splice before merging
    // the node's other keys, so earlier writes must not share a node with
    // a later op. Consecutive ops append to the same $splice list.
    const node = this.#diffTracker.getDiffObject(path);
    const clean = Object.keys(node).every(key => key === '$splice' || key === 'length');
    if (!clean) {
      return native.apply(receiver, args);
    }

    // Validate before mutating so a rejected item leaves state untouched
    // (assertSupported restores the path array, so it is safe to reuse)
    const itemPath = [...path, method];
    for (const item of items) {
      Utils.assertSupported(item, itemPath);
    }

    this.#suppress = true;
    let result;
    try {
      result = native.apply(receiver, args);
    } finally {
      this.#suppress = false;
    }

    if (!node.$splice) node.$splice = [];
    node.$splice.push([
      start,
      deleteCount,
      items.map(item => Utils.isObjectOrArray(item) ? Utils.deepClone(item) : item)
    ]);
    node.length = target.length;
    this.#eventEmitter.scheduleEmit();
    return result;
  }

  /**
   * Apply received $splice ops to a target array. Ops run through the
   * array's own proxy, so the mutation is recorded (compactly, via the
   * interception above) and re-emitted for listeners downstream of this
   * instance.
   */
  #applySpliceOps(rawTarget, ops, path) {
    const proxy = this.#proxyFor(rawTarget, path);
    for (const op of ops) {
      proxy.splice(op[0], op[1], ...(op[2] || []));
    }
  }

  /**
   * Get or create the proxy for a raw object already inside the watched tree
   */
  #proxyFor(value, path) {
    let proxy = this.#proxies.get(value);
    if (!proxy) {
      proxy = this.#createProxy(value, path, this.#instance);
      this.#proxies.set(value, proxy);
      this.#proxyPaths.set(proxy, path);
    }
    return proxy;
  }

  /**
   * When an array is truncated, drop pending diff entries for indices
   * beyond the new length — they would be trimmed by the receiver anyway
   */
  #handleArrayLengthChange(target, newLength, path) {
    if (newLength !== target.length) {
      const diff = this.#diff(path);
      for (const key in diff) {
        if (parseInt(key, 10) >= newLength) {
          delete diff[key];
        }
      }
    }
  }

  /**
   * Record a change in the diff
   */
  #recordChange(target, prop, value, path) {
    const diff = this.#diff(path);

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

    // Array fragments always carry `length`, so receivers can tell them apart
    // from plain objects even when the field doesn't exist on their side.
    // (push() never records length itself: the index assignment auto-updates
    // it, making the explicit set a no-op.)
    if (Array.isArray(target) && prop !== 'length' && /^\d+$/.test(String(prop))) {
      diff.length = target.length;
    }

    this.#scheduleEmit();
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

    // Validate external entry only; recursive calls and the set trap have
    // already validated their subtrees.
    if (path.length === 0) {
      Utils.assertSupported(this.resolveIfProxy(source));
    }

    // Get the target object (resolve proxy if needed)
    const rawTarget = this.resolveIfProxy(target);
    const rawSource = this.resolveIfProxy(source);
    let diff = null; // Lazy initialization
    let hasChanges = false;

    // Helper to get diff object only when needed
    const getDiff = () => {
      if (!diff) {
        diff = this.#diff(path);
      }
      return diff;
    };

    // Apply compact structural array ops first; the node's remaining keys
    // are merged afterwards, matching the sender-side ordering guarantee.
    if (Array.isArray(rawTarget) && Array.isArray(rawSource.$splice)) {
      this.#applySpliceOps(rawTarget, rawSource.$splice, path);
      hasChanges = true;
    }

    // Track array length changes
    if (Array.isArray(rawTarget) && Array.isArray(rawSource) && rawTarget.length !== rawSource.length) {
      rawTarget.length = rawSource.length;
      getDiff().length = rawSource.length;
      hasChanges = true;
    }

    for (const prop in rawSource) {
      // $splice was applied above (or dropped when the target isn't an array:
      // target shape wins, same as other drift cases). Reserved names in
      // hostile wire data are never applied — writing them would mutate
      // prototypes instead of data.
      if (prop === '$splice' || Utils.isUnsafeKey(prop)) continue;
      if (rawSource[prop] === null || rawSource[prop] === undefined) {
        // Record the deletion so relaying mirrors propagate it downstream
        if (prop in rawTarget) {
          getDiff()[prop] = null;
          delete rawTarget[prop];
          hasChanges = true;
        }
      } else if (Utils.isObjectOrArray(rawTarget[prop]) && Utils.isObjectOrArray(rawSource[prop])) {
        this.overwrite(rawTarget[prop], rawSource[prop], [...path, prop]);
      } else if (rawTarget[prop] !== rawSource[prop]) {
        // The target has no container to merge into here, so an index-keyed
        // array diff would be stored verbatim as a plain object — revive such
        // fragments into real arrays first.
        const sourceValue = Utils.reviveArrayDiffs(rawSource[prop]);
        // Handle nested nulls
        if (Utils.isObjectOrArray(sourceValue)) {
          for (const key in sourceValue) {
            if (sourceValue[key] === null) {
              delete sourceValue[key];
            }
          }
        }
        // Record the change in diff
        const clonedValue = Utils.isObjectOrArray(sourceValue) ? Utils.deepClone(sourceValue) : sourceValue;
        getDiff()[prop] = clonedValue;
        rawTarget[prop] = clonedValue;
        // Keep array fragments self-describing (see #recordChange).
        if (Array.isArray(rawTarget) && /^\d+$/.test(String(prop))) {
          getDiff().length = rawTarget.length;
        }
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
      this.#scheduleEmit();
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
   * Get the path for a given proxy
   */
  getProxyPath(proxy) {
    return this.#proxyPaths.get(proxy) || [];
  }

  /**
   * Clean up resources
   */
  dispose() {
    this.#proxies = new WeakMap();
    this.#proxyPaths = new WeakMap();
  }
}
