// utils.js - Utility functions
export const Utils = {
  /**
   * Check if value is an object or array that can be deep-watched.
   * Objects with internal slots (Date, RegExp, and the rejected collection
   * types) can't sit behind a Proxy — their methods throw "called on
   * incompatible receiver" — so they are never proxied or merged. Date and
   * RegExp are allowed as leaf values (replaced wholesale); the collection
   * types are rejected entirely, see `assertSupported`.
   */
  isObjectOrArray(val) {
    if (!val || typeof val !== 'object') return false;
    if (Array.isArray(val)) return true;
    return !(
      val instanceof Date ||
      val instanceof RegExp ||
      this.rejectedTypeName(val)
    );
  },

  /**
   * Name of the rejected collection type, or null if the value is allowed.
   * These types mutate through internal slots (map.set, arr[0] = x on typed
   * arrays, ...), so changes bypass the proxy traps entirely and would
   * silently desync replicas — LazyWatch rejects them instead of
   * half-tracking them.
   */
  rejectedTypeName(val) {
    if (val instanceof Map) return 'Map';
    if (val instanceof Set) return 'Set';
    if (val instanceof WeakMap) return 'WeakMap';
    if (val instanceof WeakSet) return 'WeakSet';
    if (val instanceof Promise) return 'Promise';
    if (val instanceof ArrayBuffer) return 'ArrayBuffer';
    if (ArrayBuffer.isView(val)) return val.constructor.name || 'TypedArray';
    return null;
  },

  /**
   * Deep-check a value entering watched state; throws a TypeError naming the
   * offending path if it contains a rejected type. Date and RegExp pass as
   * leaf values and are not walked into. Cycle-safe.
   */
  assertSupported(value, path = [], seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return;
    const rejected = this.rejectedTypeName(value);
    if (rejected) {
      const at = path.length ? ` at "${path.map(String).join('.')}"` : '';
      throw new TypeError(
        `LazyWatch cannot track ${rejected}${at}: in-place mutations bypass the proxy and would silently desync. Use a plain object or array instead.`
      );
    }
    if (!this.isObjectOrArray(value) || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      this.assertSupported(value[key], [...path, key], seen);
    }
  },

  /**
   * True for array diff fragments: a plain object whose keys are all array
   * indices and/or a `$splice` op list, plus a numeric `length` —
   * e.g. { 1: 'b', length: 2 } or { $splice: [[0, 0, ['a']]], length: 3 }.
   * At least one index or `$splice` key is required, so plain data like
   * { length: 5 } is never mistaken for an array diff.
   */
  isArrayDiff(val) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
    if (!Number.isInteger(val.length) || val.length < 0) return false;
    let hasContent = false;
    for (const key of Object.keys(val)) {
      if (key === 'length') continue;
      if (key === '$splice' || /^\d+$/.test(key)) {
        hasContent = true;
        continue;
      }
      return false;
    }
    return hasContent;
  },

  /**
   * Return the value with any array-diff-shaped nodes converted into real
   * arrays, recursively. Pure: containers are copied only where a conversion
   * happens, everything else is returned as-is.
   *
   * Array diffs are only unambiguous next to the object they apply to; use
   * this where the target has no existing container to merge into, so the
   * fragment would otherwise be stored verbatim as a plain object.
   */
  reviveArrayDiffs(value) {
    if (!this.isObjectOrArray(value)) return value;

    if (this.isArrayDiff(value)) {
      const arr = [];
      // Replay structural ops first, then index writes, then final length —
      // the same order receivers with an existing array use. Op items are
      // full values (not diff fragments), so they are not revived.
      if (Array.isArray(value.$splice)) {
        for (const op of value.$splice) {
          arr.splice(op[0], op[1], ...(op[2] || []));
        }
      }
      for (const key of Object.keys(value)) {
        if (key !== 'length' && key !== '$splice') {
          arr[Number(key)] = this.reviveArrayDiffs(value[key]);
        }
      }
      arr.length = value.length;
      return arr;
    }

    let out = value;
    for (const key of Object.keys(value)) {
      const revived = this.reviveArrayDiffs(value[key]);
      if (revived !== value[key]) {
        if (out === value) out = Array.isArray(value) ? value.slice() : { ...value };
        out[key] = revived;
      }
    }
    return out;
  },

  /**
   * Deep clone an object with support for various types
   */
  deepClone(obj, hash = new WeakMap()) {
    // Primitives
    if (Object(obj) !== obj) return obj;

    // Cyclic reference
    if (hash.has(obj)) return hash.get(obj);

    // Use structuredClone if available (modern browsers/Node 17+)
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(obj);
      } catch (e) {
        // Fall through to manual cloning for non-cloneable objects
      }
    }

    let result;

    if (obj instanceof Set) {
      result = new Set(obj);
    } else if (obj instanceof Map) {
      result = new Map(Array.from(obj, ([key, val]) => [key, this.deepClone(val, hash)]));
    } else if (obj instanceof Date) {
      result = new Date(obj);
    } else if (obj instanceof RegExp) {
      result = new RegExp(obj.source, obj.flags);
    } else if (ArrayBuffer.isView(obj)) {
      // Handle typed arrays
      result = new obj.constructor(obj);
    } else if (obj instanceof ArrayBuffer) {
      result = obj.slice(0);
    } else if (obj.constructor) {
      result = new obj.constructor();
    } else {
      result = Object.create(null);
    }

    hash.set(obj, result);

    return Object.assign(
      result,
      ...Object.keys(obj).map(key => ({ [key]: this.deepClone(obj[key], hash) }))
    );
  }
};