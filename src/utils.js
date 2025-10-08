// utils.js - Utility functions
export const Utils = {
  /**
   * Check if value is an object or array (excluding Date)
   */
  isObjectOrArray(val) {
    return val && typeof val === 'object' && !(val instanceof Date);
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