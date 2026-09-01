// utils.js - Utility functions

// Property names that collide with the prototype machinery. Writing them
// through the appliers would mutate prototypes instead of data (prototype
// pollution), so they are rejected on the way into watched state and
// skipped when applying received diffs.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// The diff wire format's structural markers: `$splice` carries structural
// array ops, `$length` the array's resulting length. Receivers consume both
// on array nodes and drop them everywhere else, so either key in watched
// state would never arrive as data on any mirror — the sender keeps it, the
// receivers consume or drop it, and the two desync silently. They are
// rejected on the way into state instead; inside a diff they are of course
// the format itself.
const RESERVED_DIFF_KEYS = new Set(['$splice', '$length']);

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
   * True for property names the diff wire format reserves for itself. Legal
   * inside a diff, rejected in watched state — see RESERVED_DIFF_KEYS
   */
  isReservedDiffKey(key) {
    return RESERVED_DIFF_KEYS.has(key);
  },
  /**
   * Check if value is an object or array that can be deep-watched.
   * Objects with internal slots (Date, RegExp, and the rejected collection
   * types) can't sit behind a Proxy — their methods throw "called on
   * incompatible receiver" — so they are never proxied or merged. All of
   * them are rejected from watched state (see `assertSupported`); Date and
   * RegExp are still recognized here so the general-purpose clone and
   * equality helpers treat them as leaves.
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
   * True for objects that survive cloning and JSON intact: prototype is
   * null or one step from null (Object.prototype, including other realms'.
   * A class instance's chain is at least two steps: its prototype, then
   * Object.prototype). Arrays are not plain objects.
   */
  isPlainObject(val) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
    const proto = Object.getPrototypeOf(val);
    return proto === null || Object.getPrototypeOf(proto) === null;
  },

  /**
   * Deep-check a value entering watched state; throws a TypeError naming the
   * offending path if it contains a rejected type, a class instance, a
   * reserved property name, or a value JSON cannot carry faithfully: a
   * non-finite number, a bigint, a symbol, a function, a Date (serialized
   * as a string, so mirrors hold a string where the sender holds a Date
   * and the types drift), or a RegExp (serialized as `{}`). Cycle-safe.
   *
   * `isDiff` relaxes the reserved-diff-key rule, which exists only because
   * state has to survive the round trip through the wire format — inside a
   * diff those keys are the format doing its job. `$splice` op items are
   * the exception: they are full values entering state, so they are held to
   * state rules even in diff context. Use `assertSupportedDiff` for diff
   * call sites.
   *
   * Perf note: the walk mutates `path` push/pop-style instead of copying it
   * per key, and only renders it into a string on the (cold) error path.
   * The array is restored before returning; on a throw it is abandoned
   * mid-walk, which is fine — every caller passes a fresh array.
   */
  assertSupported(value, path = [], seen = new WeakSet(), isDiff = false) {
    const kind = typeof value;
    if (kind === 'number' && !Number.isFinite(value)) {
      throw new TypeError(
        `LazyWatch cannot track non-finite number ${value}${pathLabel(path)}: JSON serializes it as null, which receivers interpret as a deletion.`
      );
    }
    if (kind === 'bigint' || kind === 'symbol' || kind === 'function') {
      const effect = kind === 'bigint' ? 'JSON.stringify throws on it' : 'JSON drops it';
      const hint = kind === 'bigint'
        ? 'Store it as a string or a number instead.'
        : 'Store plain data instead, or keep it under a symbol key for local-only state.';
      throw new TypeError(
        `LazyWatch cannot track a ${kind} value${pathLabel(path)}: ${effect}, so it could never reach a mirror. ${hint}`
      );
    }
    if (!value || kind !== 'object') return;
    if (value instanceof Date) {
      throw new TypeError(
        `LazyWatch cannot track Date${pathLabel(path)}: JSON serializes it as a string, so mirrors hold a string where the sender holds a Date and the types drift. Store a timestamp (date.getTime()) or an ISO string instead.`
      );
    }
    if (value instanceof RegExp) {
      throw new TypeError(
        `LazyWatch cannot track RegExp${pathLabel(path)}: JSON serializes it as {}, so mirrors silently desync. Store its source and flags as strings instead.`
      );
    }
    const rejected = this.rejectedTypeName(value);
    if (rejected) {
      throw new TypeError(
        `LazyWatch cannot track ${rejected}${pathLabel(path)}: in-place mutations bypass the proxy and would silently desync. Use a plain object or array instead.`
      );
    }
    if (!this.isObjectOrArray(value) || seen.has(value)) return;
    if (!Array.isArray(value) && !this.isPlainObject(value)) {
      // Class instances are half-trackable at best: cloning and JSON strip
      // their prototype, silently losing methods — fail loudly instead
      const name = value.constructor && value.constructor.name && value.constructor.name !== 'Object'
        ? `a ${value.constructor.name} instance`
        : 'an object with a custom prototype';
      throw new TypeError(
        `LazyWatch cannot track ${name}${pathLabel(path)}: its prototype and methods are silently lost on clone and sync. Use a plain object, or store it under a symbol key for local-only state.`
      );
    }
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (this.isUnsafeKey(key)) {
        throw new TypeError(
          `LazyWatch cannot use reserved property name "${key}"${pathLabel(path)}: it collides with the prototype machinery.`
        );
      }
      if (this.isReservedDiffKey(key)) {
        if (!isDiff) {
          throw new TypeError(
            `LazyWatch cannot use reserved property name "${key}"${pathLabel(path)}: it belongs to the diff wire format (structural array ops and lengths), so receivers consume or drop it instead of storing it as data, and mirrors desync silently. Rename the property.`
          );
        }
        // In diff context the key is the format's own vocabulary — but
        // `$splice` op items are full values entering state, so they are
        // held to state rules here, before the applier mutates anything.
        // The generic recursion below still covers the ops' numeric fields
        // (the seen guard keeps already-walked items from being rewalked).
        if (key === '$splice' && Array.isArray(value[key])) {
          path.push(key);
          for (const op of value[key]) {
            if (Array.isArray(op) && Array.isArray(op[2])) {
              for (const item of op[2]) {
                this.assertSupported(item, path, seen, false);
              }
            }
          }
          path.pop();
        }
      }
      path.push(key);
      this.assertSupported(value[key], path, seen, isDiff);
      path.pop();
    }
  },

  /**
   * Deep-check a diff (a patch fragment, an inverse, a snapshot handed to
   * `overwrite`) rather than a value entering state. Same rules, except that
   * the wire format's own reserved keys (`$splice`, `$length`) are allowed —
   * while `$splice` op items, being full values, still get the state rules.
   */
  assertSupportedDiff(value, path = []) {
    this.assertSupported(value, path, new WeakSet(), true);
  },

  /**
   * Deep-check the object handed to the constructor, which LazyWatch keeps
   * by reference (every value entering later is cloned on the way in, so
   * only this object can carry these traits). A frozen, sealed, or
   * non-extensible container, or a property that is an accessor or not
   * enumerable/writable/configurable, would make a later tracked write
   * fail natively AFTER its diff entry was recorded — the phantom entry
   * then rides along with the next batch and desyncs every mirror. Same
   * rules the defineProperty and preventExtensions traps enforce on live
   * state. Walks plain objects and arrays only; run after
   * `assertSupported`. Cycle-safe.
   */
  assertTrackable(value, path = [], seen = new WeakSet()) {
    if (!this.isObjectOrArray(value) || seen.has(value)) return;
    seen.add(value);
    if (!Object.isExtensible(value)) {
      throw new TypeError(
        `LazyWatch cannot watch a frozen, sealed, or non-extensible object${pathLabel(path)}: writes to it could not be tracked. Watch an extensible copy instead (e.g. structuredClone).`
      );
    }
    const isArray = Array.isArray(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (isArray && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if ('get' in descriptor || 'set' in descriptor) {
        throw new TypeError(
          `LazyWatch cannot watch the accessor property "${key}"${pathLabel(path)}: getters and setters bypass change tracking and do not survive cloning or sync. Use a plain value instead.`
        );
      }
      if (!descriptor.enumerable || !descriptor.writable || !descriptor.configurable) {
        throw new TypeError(
          `LazyWatch cannot watch the non-enumerable, non-writable, or non-configurable property "${key}"${pathLabel(path)}: such properties do not survive cloning and sync. Define it as a plain property instead.`
        );
      }
      path.push(key);
      this.assertTrackable(descriptor.value, path, seen);
      path.pop();
    }
  },

  /**
   * True for array diff fragments: a plain object carrying the wire
   * format's numeric `$length` marker, whose other keys are all array
   * indices and/or a `$splice` op list — e.g. { 1: 'b', $length: 2 } or
   * { $splice: [[0, 0, ['a']]], $length: 3 }. `$length` alone is a valid
   * fragment (a pure truncation); since the key is reserved, plain data
   * can never be mistaken for one.
   */
  isArrayDiff(val) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
    if (!Number.isInteger(val.$length) || val.$length < 0) return false;
    for (const key of Object.keys(val)) {
      if (key === '$length' || key === '$splice' || /^\d+$/.test(key)) continue;
      return false;
    }
    return true;
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
        if (key !== '$length' && key !== '$splice') {
          arr[Number(key)] = this.reviveArrayDiffs(value[key]);
        }
      }
      arr.length = value.$length;
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
   * old container anyway. Reserved names are skipped like everywhere else —
   * including the wire format's own (`$splice`, `$length`), which callers
   * have already consumed and which must never be stored as data.
   */
  cloneWithoutNulls(value) {
    if (!this.isObjectOrArray(value)) return this.deepClone(value);
    const out = Array.isArray(value) ? [] : {};
    if (Array.isArray(value)) out.length = value.length;
    for (const key of Object.keys(value)) {
      if (this.isUnsafeKey(key) || this.isReservedDiffKey(key)) continue;
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