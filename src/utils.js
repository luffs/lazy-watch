// utils.js - Utility functions

// Property names that collide with the prototype machinery. Writing them
// through the appliers would mutate prototypes instead of data (prototype
// pollution), so they are rejected on the way into watched state and
// skipped when applying received diffs.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Error-path helper: renders a path prefix for validation messages
const pathLabel = path => path.length ? ` at "${path.map(String).join('.')}"` : '';

export const Utils = {
  /**
   * True for property names that are rejected in watched state because
   * assigning them collides with the prototype machinery
   */
  isUnsafeKey(key) {
    return UNSAFE_KEYS.has(key);
  },
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
   * offending path if it contains a rejected type, a non-finite number, or
   * a reserved property name. Date and RegExp pass as leaf values and are
   * not walked into. Cycle-safe.
   *
   * Perf note: the walk mutates `path` push/pop-style instead of copying it
   * per key, and only renders it into a string on the (cold) error path.
   * The array is restored before returning; on a throw it is abandoned
   * mid-walk, which is fine — every caller passes a fresh array.
   */
  assertSupported(value, path = [], seen = new WeakSet()) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(
        `LazyWatch cannot track non-finite number ${value}${pathLabel(path)}: JSON serializes it as null, which receivers interpret as a deletion.`
      );
    }
    if (!value || typeof value !== 'object') return;
    const rejected = this.rejectedTypeName(value);
    if (rejected) {
      throw new TypeError(
        `LazyWatch cannot track ${rejected}${pathLabel(path)}: in-place mutations bypass the proxy and would silently desync. Use a plain object or array instead.`
      );
    }
    if (!this.isObjectOrArray(value) || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (this.isUnsafeKey(key)) {
        throw new TypeError(
          `LazyWatch cannot use reserved property name "${key}"${pathLabel(path)}: it collides with the prototype machinery.`
        );
      }
      path.push(key);
      this.assertSupported(value[key], path, seen);
      path.pop();
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
      // Reserved names in hostile wire data are never revived or written
      if (this.isUnsafeKey(key)) continue;
      const revived = this.reviveArrayDiffs(value[key]);
      if (revived !== value[key]) {
        if (out === value) out = Array.isArray(value) ? value.slice() : { ...value };
        out[key] = revived;
      }
    }
    return out;
  },

  /**
   * Deep structural equality for diff values: leaves by identity (Date by
   * time, RegExp by source+flags), containers by keys and recursion.
   * Used to detect no-op wholesale replacements so re-applying an
   * already-applied diff records and emits nothing (echo stability).
   */
  deepEqual(a, b) {
    if (a === b) return true;
    if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
    if (a instanceof RegExp) return b instanceof RegExp && a.source === b.source && a.flags === b.flags;
    if (!this.isObjectOrArray(a) || !this.isObjectOrArray(b)) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!(key in b) || !this.deepEqual(a[key], b[key])) return false;
    }
    return true;
  },

  /**
   * Deep clone a container value dropping every null/undefined entry.
   *
   * Used when a diff value is applied wholesale (no existing container to
   * merge into): nulls in diffs mean "delete", so they must never be
   * stored as literal state. Full values recorded from watched state never
   * contain nulls (assigning null is a deletion), so for them this is a
   * plain clone; for patch fragments — including inverse-diff arrays,
   * whose elements carry null markers for keys to delete — dropping the
   * marker is exactly the deletion, since the wholesale write replaces the
   * old container anyway. Reserved names are skipped like everywhere else.
   */
  cloneWithoutNulls(value) {
    if (!this.isObjectOrArray(value)) return this.deepClone(value);
    const out = Array.isArray(value) ? [] : {};
    if (Array.isArray(value)) out.length = value.length;
    for (const key of Object.keys(value)) {
      if (this.isUnsafeKey(key)) continue;
      const entry = value[key];
      if (entry === null || entry === undefined) continue;
      out[key] = this.isObjectOrArray(entry) ? this.cloneWithoutNulls(entry) : this.deepClone(entry);
    }
    return out;
  },

  /**
   * Deep clone a value.
   *
   * Uses structuredClone when available (Node 17+, all modern browsers) and
   * falls back to manual cloning when it is missing or throws (e.g. the value
   * contains a function). The manual path only handles what can occur in
   * watched state — plain objects, arrays, Date and RegExp leaves — since the
   * collection types are rejected by `assertSupported` before any clone
   * happens. Functions are copied by reference. Cycle-safe on both paths.
   */
  deepClone(obj, hash = new WeakMap()) {
    // Primitives, and functions (copied by reference)
    if (Object(obj) !== obj || typeof obj === 'function') return obj;

    // Cyclic reference
    if (hash.has(obj)) return hash.get(obj);

    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(obj);
      } catch (e) {
        // Fall through to manual cloning for non-cloneable objects
      }
    }

    if (obj instanceof Date) return new Date(obj);
    if (obj instanceof RegExp) return new RegExp(obj.source, obj.flags);

    // Plain objects and arrays. Like structuredClone, custom prototypes are
    // not preserved.
    const result = Array.isArray(obj) ? [] : {};
    hash.set(obj, result);
    for (const key of Object.keys(obj)) {
      result[key] = this.deepClone(obj[key], hash);
    }
    return result;
  }
};