// utils.js - Utility functions
export const Utils = {
  /**
   * Check if value is an object or array (excluding Date)
   */
  isObjectOrArray(val) {
    return val && typeof val === 'object' && !(val instanceof Date);
  },

  /**
   * True for index-keyed array diff fragments, e.g. { 1: 'b', length: 2 }:
   * a plain object whose keys are all array indices plus a numeric `length`.
   * At least one index key is required, so plain data like { length: 5 }
   * is never mistaken for an array diff.
   */
  isArrayDiff(val) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
    if (!Number.isInteger(val.length) || val.length < 0) return false;
    const keys = Object.keys(val);
    return keys.length > 1 && keys.every(key => key === 'length' || /^\d+$/.test(key));
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
      const arr = new Array(value.length);
      for (const key of Object.keys(value)) {
        if (key !== 'length') arr[Number(key)] = this.reviveArrayDiffs(value[key]);
      }
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