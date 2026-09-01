// proxy-handler.js - Handles proxy creation and management
import {Utils} from "./utils.js";

export const PROXY_TARGET = Symbol('LazyWatch.ProxyTarget');
export const LAZYWATCH_INSTANCE = Symbol('LazyWatch.Instance');

// Array methods whose per-index trap writes are collapsed into compact
// `$splice` diff ops. push/pop are already cheap (tail-only) and stay as-is.
const STRUCTURAL_ARRAY_METHODS = new Set(['splice', 'unshift', 'shift']);

// Array methods that rearrange existing elements in place. Run natively
// through the proxy, their read-all/write-back pattern corrupts object
// elements: the set trap's slot-merge mutates the raw object at each
// written slot in place, while that same object may still be the pending
// source for a later slot — the later write then reads already-overwritten
// state (sorting [{n:3},{n:1},{n:2}] produced [{n:1},{n:2},{n:1}]).
// splice's own shifts are safe (its move order never overwrites a slot it
// has yet to read), but these three permute in both directions.
const REORDER_ARRAY_METHODS = new Set(['sort', 'reverse', 'copyWithin']);

// Sentinel for "this path no longer resolves in the watched tree"
const MISSING = Symbol('LazyWatch.Missing');

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
    // The constructor argument is kept by reference (everything entering
    // later is cloned), so frozen containers and exotic properties can
    // only arrive here — reject them before a write can fail mid-record
    Utils.assertTrackable(original);
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

        // Intercept reordering methods: run natively, they corrupt object
        // elements via slot-merge aliasing (see REORDER_ARRAY_METHODS)
        if (Array.isArray(target) && REORDER_ARRAY_METHODS.has(prop) &&
          value === Array.prototype[prop]) {
          return (...args) => this.#reorderArrayOp(target, prop, args, path, receiver);
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

      set: (target, prop, value, receiver) =>
        this.#applySet(target, prop, value, receiver, path),

      // Route Object.defineProperty through the same tracked write path as
      // assignment. Without this trap, defineProperty mutated the target
      // silently — nothing recorded, nothing emitted, mirrors desynced.
      // Only descriptors whose net effect equals a plain assignment are
      // trackable; everything else is rejected loudly.
      defineProperty: (target, prop, descriptor) => {
        // Symbol-keyed properties are local-only metadata, as in `set`
        if (typeof prop === 'symbol') {
          Object.defineProperty(target, prop, descriptor);
          return true;
        }
        if ('get' in descriptor || 'set' in descriptor) {
          throw new TypeError(
            `LazyWatch cannot define an accessor for "${String(prop)}": getters and setters bypass change tracking and do not survive cloning or sync. Assign a plain value instead.`
          );
        }
        // The resulting property must stay enumerable, writable, and
        // configurable. Attributes absent from the descriptor keep the
        // current property's (or default to false on a new property — the
        // defineProperty default).
        const current = Object.getOwnPropertyDescriptor(target, prop);
        const attr = name => name in descriptor ? descriptor[name] : current ? !!current[name] : false;
        if (!attr('enumerable') || !attr('writable') || !attr('configurable')) {
          throw new TypeError(
            `LazyWatch cannot define "${String(prop)}" as non-enumerable, non-writable, or non-configurable: such properties do not survive cloning and sync. Use a plain assignment.`
          );
        }
        // Flags-only redefinition: every attribute is already true, so
        // there is nothing to change or record
        if (!('value' in descriptor)) return true;
        return this.#applySet(target, prop, descriptor.value, this.#proxies.get(target), path);
      },

      setPrototypeOf: (target, proto) => {
        // Re-asserting the current prototype is a harmless no-op
        if (proto === Object.getPrototypeOf(target)) return true;
        throw new TypeError(
          'LazyWatch cannot change the prototype of watched state: prototype mutations are untracked and would not survive cloning or sync.'
        );
      },

      preventExtensions: () => {
        // Object.freeze/seal call this first; rejecting up front keeps the
        // target extensible instead of leaving it half-frozen with future
        // writes failing halfway through the traps
        throw new TypeError(
          'LazyWatch cannot make watched state non-extensible (Object.freeze, Object.seal, Object.preventExtensions): future changes could not be tracked.'
        );
      },

      deleteProperty: (target, prop) => {
        // Symbol-keyed properties are local-only: deleted without recording
        if (typeof prop === 'symbol') {
          delete target[prop];
          return true;
        }
        this.#assertAttached(target, path);

        if (prop in target) {
          this.#recordDeletion(target, prop, path);
          delete target[prop];
          this.#scheduleEmit();
        }
        return true;
      }
    });
  }

  /**
   * Record the deletion of `prop` at `path` (inverse capture, container
   * loss, and the null marker) ahead of the delete itself. On arrays the
   * fragment is stamped with `$length` like every other array fragment,
   * so a deletion stays self-describing on the wire — a receiver that
   * lacks the field revives it as an array instead of storing an object.
   */
  #recordDeletion(target, prop, path) {
    const isArray = Array.isArray(target);
    if (this.#inverseActive()) {
      this.#diffTracker.recordInverse(path, prop, target[prop]);
      if (isArray) this.#diffTracker.recordInverse(path, '$length', target.length);
    }
    this.#recordLoss(path, prop, target[prop]);
    const diff = this.#diff(path);
    diff[prop] = null;
    if (isArray) diff.$length = target.length;
  }

  /**
   * The raw value at `path` in the watched tree, or MISSING when the path
   * no longer resolves. Segments are own-property lookups only, so hostile
   * or stale paths can never walk into a prototype.
   */
  #valueAt(path) {
    let current = this.#original;
    for (let i = 0; i < path.length; i++) {
      if (!Utils.isObjectOrArray(current) || !Object.hasOwn(current, path[i])) {
        return MISSING;
      }
      current = current[path[i]];
    }
    return current;
  }

  /**
   * Whether `path` still resolves in the watched tree, and to what — for
   * the emitter, which delivers the live value to nested listeners whose
   * array slot was displaced by a structural op.
   * @returns {{ found: boolean, value?: * }}
   */
  valueAt(path) {
    const value = this.#valueAt(path);
    return value === MISSING ? { found: false } : { found: true, value };
  }

  /**
   * A proxy's raw object stays at its slot for its whole life (assigned
   * values are cloned, containers merge in place), so the object behind a
   * cached proxy is either still at the proxy's path or detached from the
   * tree entirely — deleted, replaced by a leaf, truncated away, or
   * removed by a structural array op. A tracked write through a detached
   * proxy would mutate an object no replica can see while recording a
   * diff at a path that no longer holds it, so it fails loudly instead.
   */
  #assertAttached(target, path) {
    if (this.#valueAt(path) !== target) {
      throw new Error(
        `LazyWatch proxy is detached: the object it wraps is no longer at "${path.join('.')}" in the watched tree (it was deleted, replaced, truncated away, or removed by a structural array op). Re-read it from the root proxy.`
      );
    }
  }

  /**
   * The `set` trap body, shared with the defineProperty trap: validates the
   * value, records the change (or deletion, for undefined) in the diff, and
   * applies it to the target.
   */
  #applySet(target, prop, value, receiver, path) {
    // Symbol-keyed properties are local-only metadata: stored on the
    // target but never recorded, emitted, or synced (JSON cannot carry
    // them anyway). They are also exempt from value validation, since
    // their values never reach the wire.
    if (typeof prop === 'symbol') {
      target[prop] = this.resolveIfProxy(value);
      return true;
    }

    this.#assertAttached(target, path);

    // Assigning these would mutate prototypes, not data
    if (Utils.isUnsafeKey(prop)) {
      throw new TypeError(
        `LazyWatch cannot set reserved property name "${prop}": it collides with the prototype machinery.`
      );
    }

    // The wire format claims these names for structural array ops and
    // lengths, so every receiver's applier consumes or drops them — the
    // value would live on the sender and nowhere else
    if (Utils.isReservedDiffKey(prop)) {
      throw new TypeError(
        `LazyWatch cannot set reserved property name "${prop}": it belongs to the diff wire format (structural array ops and lengths), so receivers consume or drop it instead of storing it as data, and mirrors desync silently. Rename the property.`
      );
    }

    // Resolve if value is a proxy
    value = this.resolveIfProxy(value);

    // Reject Map/Set/typed arrays, Date/RegExp, bigint/symbol/function,
    // non-finite numbers, and reserved names anywhere in the assigned
    // value. Guarded so plain JSON-safe primitive writes skip the
    // validation call and its path allocation entirely.
    const kind = typeof value;
    if ((kind === 'object' && value !== null) || kind === 'function' ||
      kind === 'bigint' || kind === 'symbol' ||
      (kind === 'number' && !Number.isFinite(value))) {
      Utils.assertSupported(value, [...path, prop]);
    }

    // Assigning undefined would silently vanish from JSON diffs on the
    // wire; treat it as a deletion to match the null-means-delete
    // convention. (Array length falls through to the native error.)
    if (value === undefined && !(Array.isArray(target) && prop === 'length')) {
      if (prop in target) {
        this.#recordDeletion(target, prop, path);
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

    // Merge container-over-container writes: object over object, fragment
    // over array, and array over array (element-wise, recording a minimal
    // array fragment instead of the wholesale value). The exception is a
    // real array assigned over a plain object — merging that would leave a
    // plain object with index keys behind, so it replaces wholesale below.
    // An assigned value is a full value, so the merge runs in wholesale
    // mode: it must delete what the value doesn't carry even during patch
    // application (structural-op slot writes ride through this trap).
    const arrayOverObject = currentIsObject && Array.isArray(value) && !Array.isArray(currentValue);
    if (currentIsObject && valueIsObject && !arrayOverObject) {
      this.overwrite(receiver[prop], value, [...path, prop], true, true);
    } else if (currentValue !== value) {
      this.#recordChange(target, prop, value, path);
    }

    return true;
  }

  /**
   * Intercepted sort/reverse/copyWithin on a watched array.
   *
   * Run natively through the proxy, these methods read elements and write
   * them back rearranged; the set trap's slot-merge then mutates the raw
   * object at each written slot in place, while that same object may still
   * be the pending source for a later slot — later writes read
   * already-overwritten state and corrupt elements.
   *
   * Instead, the final arrangement is computed natively on a detached copy
   * of the raw elements, and every relocated element is cloned BEFORE the
   * first write-back. The clones are then assigned through the proxy, so
   * recording, inverse capture, and echo semantics all run normally.
   * Length never changes, so only relocated slots emit; a throwing sort
   * comparator leaves state untouched (the copy absorbs any partial work).
   * Note that a sort comparator sees raw elements, not proxies — reads
   * behave identically, and comparators must not mutate.
   */
  #reorderArrayOp(target, method, args, path, receiver) {
    this.#assertAttached(target, path);
    const copy = target.slice();
    Array.prototype[method].apply(copy, args);

    const writes = [];
    for (let i = 0; i < copy.length; i++) {
      if (target[i] !== copy[i]) {
        writes.push([i, Utils.isObjectOrArray(copy[i]) ? Utils.deepClone(copy[i]) : copy[i]]);
      }
    }
    for (const [index, value] of writes) {
      receiver[index] = value;
    }
    // All three methods return the array they were called on
    return receiver;
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
   * True when pre-change values should be captured for the inverse diff.
   * Suppression covers both structural-op internals and rollback itself.
   */
  #inverseActive() {
    return this.#diffTracker.inverseEnabled && !this.#suppress;
  }

  /**
   * Remember a container destroyed this batch (deleted, replaced by a
   * leaf, or truncated away). If the slot is recreated as an object later
   * in the same batch, #staleFilledDiffValue null-fills the recreation's
   * diff so receivers delete the stale keys they still hold.
   */
  #recordLoss(path, prop, value) {
    if (!this.#suppress && Utils.isObjectOrArray(value)) {
      this.#diffTracker.recordContainerLoss(path, prop, value);
    }
  }

  /**
   * The value to record in the diff for a wholesale write at path+prop.
   *
   * Plain when nothing stale exists. When a container was destroyed at
   * this slot earlier in the batch (or `stale` is passed directly by a
   * replacement site), receivers still hold it — a plain object recorded
   * here would merge into it instead of replacing it. The returned copy
   * records null for every stale key the new value doesn't carry
   * (recursing through shared plain-object keys), so applying the diff
   * deletes them. The copy is separate from the target's value: the null
   * markers belong on the wire, never in local state.
   *
   * Arrays need no filling — receivers apply real arrays wholesale.
   */
  #staleFilledDiffValue(clonedValue, path, prop, stale) {
    if (this.#suppress || !Utils.isObjectOrArray(clonedValue) || Array.isArray(clonedValue)) {
      return clonedValue;
    }
    // The batch's first loss wins over a same-call replacement: receivers
    // are at the pre-batch state
    const lost = this.#diffTracker.getContainerLoss(path, prop) ??
      (Utils.isObjectOrArray(stale) ? stale : undefined);
    if (!lost || Array.isArray(lost)) return clonedValue;

    const filled = Utils.deepClone(clonedValue);
    this.#nullFillStale(filled, lost);
    return filled;
  }

  /**
   * Record null in `diffValue` for every key of the stale container it
   * doesn't carry; recurse where both sides are plain objects. Array and
   * leaf values in the diff are applied wholesale by receivers, so
   * recursion stops there.
   */
  #nullFillStale(diffValue, stale) {
    for (const key of Object.keys(stale)) {
      if (Utils.isUnsafeKey(key)) continue;
      if (!(key in diffValue)) {
        diffValue[key] = null;
      } else if (
        Utils.isObjectOrArray(diffValue[key]) && !Array.isArray(diffValue[key]) &&
        Utils.isObjectOrArray(stale[key]) && !Array.isArray(stale[key])
      ) {
        this.#nullFillStale(diffValue[key], stale[key]);
      }
    }
  }

  /**
   * Apply an inverse diff to restore pre-batch state, without recording or
   * emitting anything. Used by LazyWatch.transaction() on failure.
   */
  rollback(inverse) {
    this.#suppress = true;
    try {
      this.patch(this.#original, inverse);
    } finally {
      this.#suppress = false;
    }
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
    this.#assertAttached(target, path);
    const native = Array.prototype[method];
    const len = target.length;

    // Inserted items are full values landing in state, so validate them
    // before anything mutates. This has to happen ahead of the fallback
    // branches below: those run the native method straight away, and the
    // per-index set traps would then reject mid-splice, after the shift
    // writes had already moved elements.
    const inserted = method === 'splice' ? args.slice(2)
      : method === 'unshift' ? args
      : [];
    if (inserted.length) {
      const itemPath = [...path, method];
      for (const item of inserted) {
        Utils.assertSupported(this.resolveIfProxy(item), itemPath);
      }
    }

    // Inverse tracking disables the compact form entirely: a $splice op
    // cannot be correctly interleaved with per-key inverse entries
    // (receivers apply $splice before a node's other keys, breaking
    // chronological undo ordering), while plain trap-driven recording is
    // handled exactly by the per-key inverse rules. Correct, just larger.
    if (this.#diffTracker.inverseEnabled) {
      return native.apply(receiver, args);
    }

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
    const clean = Object.keys(node).every(key => key === '$splice' || key === '$length');
    if (!clean) {
      return native.apply(receiver, args);
    }

    // Items were validated above, before any branch could mutate

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
    node.$length = target.length;
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
      // Truncation destroys elements; capture them (holes excluded) so the
      // inverse can restore them, and record container losses so a
      // same-batch recreation at those indices null-fills its diff.
      // Growth records nothing here.
      for (let i = newLength; i < target.length; i++) {
        if (i in target) {
          if (this.#inverseActive()) {
            this.#diffTracker.recordInverse(path, String(i), target[i]);
          }
          this.#recordLoss(path, String(i), target[i]);
        }
      }
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

    // An array's `length` is recorded in the diff under the wire format's
    // `$length` marker; `length` on a plain object is ordinary data
    const isArrayLength = Array.isArray(target) && prop === 'length';
    const diffKey = isArrayLength ? '$length' : prop;

    // Handle array index updates when $length was previously set
    if (typeof diff.$length === 'number') {
      const index = parseInt(prop, 10);
      if (!isNaN(index) && diff.$length <= index) {
        diff.$length = index + 1;
      }
    }

    // Only clone if it's an object/array
    const clonedValue = Utils.isObjectOrArray(value) ? Utils.deepClone(value) : value;
    const isArrayIndex = Array.isArray(target) && prop !== 'length' && /^\d+$/.test(String(prop));

    // Capture pre-change values before the writes below (inverse diffs are
    // wire fragments, so they carry the same $length marker)
    if (this.#inverseActive()) {
      this.#diffTracker.recordInverse(
        path, diffKey, prop in target ? target[prop] : undefined, clonedValue);
      if (isArrayIndex) {
        this.#diffTracker.recordInverse(path, '$length', target.length);
      }
    }

    // A container replaced by a leaf is destroyed from the receivers'
    // point of view; remember it so a same-batch recreation null-fills
    if (!Utils.isObjectOrArray(value)) {
      this.#recordLoss(path, prop, target[prop]);
    }

    // The diff copy may diverge from the state copy: a recreation over a
    // container destroyed earlier this batch carries null markers for the
    // receivers' stale keys, which must never enter local state
    diff[diffKey] = this.#staleFilledDiffValue(clonedValue, path, prop);
    target[prop] = clonedValue;

    // Array fragments always carry `$length`, so receivers can tell them
    // apart from plain objects even when the field doesn't exist on their
    // side. (push() never records length itself: the index assignment
    // auto-updates it, making the explicit set a no-op.)
    if (isArrayIndex) {
      diff.$length = target.length;
    }

    this.#scheduleEmit();
  }

  /**
   * Overwrite target with source properties
   * @param {Object} target - The target object (or proxy)
   * @param {Object} source - The source object with new values
   * @param {Array} path - The path to the current object (defaults to [] for
   *   root; external calls entering at a nested proxy pass its path so the
   *   diff is recorded where the subtree lives)
   * @param {boolean} internal - True for recursive calls and the set trap,
   *   whose subtrees are already validated
   * @param {boolean} wholesale - True when `source` is a full value rather
   *   than a patch fragment (set-trap assignments, and everything inside a
   *   real-array source — the wire contract makes real arrays wholesale).
   *   Containers still merge element-wise so the recorded diff stays
   *   minimal, but only between same-kind containers, and missing keys are
   *   deleted even in patch mode — giving receivers the exact wholesale
   *   outcome
   */
  overwrite(target, source, path = [], internal = false, wholesale = false) {
    if (!source || typeof source !== 'object') {
      throw new TypeError('Source must be an object');
    }

    // Validate external entry only; recursive calls and the set trap have
    // already validated their subtrees. (An explicit flag, not a
    // path-emptiness check: external calls may enter at a nested path.)
    // Diff context: the source is a patch fragment, so `$splice` ops and
    // index-keyed array fragments are the format, not corrupt data.
    if (!internal) {
      Utils.assertSupportedDiff(this.resolveIfProxy(source));
    }

    // Get the target object (resolve proxy if needed)
    const rawTarget = this.resolveIfProxy(target);
    const rawSource = this.resolveIfProxy(source);

    // An external call entering through a detached nested proxy would
    // record its diff at a path that no longer holds the object
    if (!internal) {
      this.#assertAttached(rawTarget, path);
    }
    // Inside a real-array source every entry is a full value, never a
    // fragment; the whole subtree below it applies with wholesale semantics
    wholesale = wholesale || Array.isArray(rawSource);
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

    // Track array length changes, with the same semantics as a `length`
    // assignment through the trap: inverse capture and container-loss
    // recording for truncated elements, and stale diff indices beyond the
    // new length trimmed
    if (Array.isArray(rawTarget) && Array.isArray(rawSource) && rawTarget.length !== rawSource.length) {
      this.#handleArrayLengthChange(rawTarget, rawSource.length, path);
      if (this.#inverseActive()) {
        this.#diffTracker.recordInverse(path, '$length', rawTarget.length);
      }
      rawTarget.length = rawSource.length;
      getDiff().$length = rawSource.length;
      hasChanges = true;
    }

    for (const prop in rawSource) {
      // $splice was applied above and $length is applied after the loop
      // (both dropped when the target isn't an array: target shape wins,
      // same as other drift cases). Reserved names in hostile wire data
      // are never applied — writing them would mutate prototypes instead
      // of data.
      if (prop === '$splice' || prop === '$length' || Utils.isUnsafeKey(prop)) continue;
      if (rawSource[prop] === null || rawSource[prop] === undefined) {
        // Record the deletion so relaying mirrors propagate it downstream
        if (prop in rawTarget) {
          getDiff();
          this.#recordDeletion(rawTarget, prop, path);
          delete rawTarget[prop];
          hasChanges = true;
        }
      } else if (Utils.isObjectOrArray(rawTarget[prop]) && Utils.isObjectOrArray(rawSource[prop]) &&
        (wholesale
          ? Array.isArray(rawTarget[prop]) === Array.isArray(rawSource[prop])
          : !(Array.isArray(rawSource[prop]) && !Array.isArray(rawTarget[prop])))) {
        // Merge containers instead of replacing them, so the recorded diff
        // carries only real differences. In fragment context (a received
        // diff), an object merges into an object or an array — but a real
        // array is a wholesale value, so it only merges element-wise into
        // another array, never into a plain object. In wholesale context
        // every entry is a full value: same-kind containers merge (with
        // missing keys deleted, giving the exact wholesale outcome), and a
        // kind mismatch falls through to the replacement branch below.
        this.overwrite(rawTarget[prop], rawSource[prop], [...path, prop], true, wholesale);
      } else if (rawTarget[prop] !== rawSource[prop]) {
        const prevValue = rawTarget[prop];
        // Re-applying an already-applied wholesale value must record and
        // emit nothing, or bidirectional mirrors would echo forever
        if (Utils.isObjectOrArray(prevValue) && Utils.isObjectOrArray(rawSource[prop]) &&
          Utils.deepEqual(prevValue, rawSource[prop])) {
          continue;
        }
        // The target has no container to merge into here (or the value is
        // a wholesale replacement), so an index-keyed array diff would be
        // stored verbatim as a plain object — revive such fragments into
        // real arrays first.
        const sourceValue = Utils.reviveArrayDiffs(rawSource[prop]);
        // Container values are applied wholesale: drop null markers (null
        // means delete, and the replacement discards the old container
        // anyway) without mutating the caller's source
        const clonedValue = Utils.isObjectOrArray(sourceValue)
          ? Utils.cloneWithoutNulls(sourceValue)
          : sourceValue;
        if (this.#inverseActive()) {
          this.#diffTracker.recordInverse(
            path, prop, prop in rawTarget ? prevValue : undefined, clonedValue);
          if (Array.isArray(rawTarget) && /^\d+$/.test(String(prop))) {
            this.#diffTracker.recordInverse(path, '$length', rawTarget.length);
          }
        }
        this.#recordLoss(path, prop, prevValue);
        // The diff copy null-fills stale keys receivers still hold (from a
        // container destroyed earlier this batch, or replaced right here)
        getDiff()[prop] = this.#staleFilledDiffValue(clonedValue, path, prop, prevValue);
        rawTarget[prop] = clonedValue;
        // Keep array fragments self-describing (see #recordChange).
        if (Array.isArray(rawTarget) && /^\d+$/.test(String(prop))) {
          getDiff().$length = rawTarget.length;
        }
        hasChanges = true;
      }
    }

    // A fragment's `$length` marker adopts the array's final length after
    // its index keys have merged, matching the sender-side ordering (the
    // real-array case was handled before the loop; on a non-array target
    // the marker is dropped — target shape wins, like `$splice`)
    if (Array.isArray(rawTarget) && !Array.isArray(rawSource) &&
      typeof rawSource.$length === 'number' && rawTarget.length !== rawSource.$length) {
      if (this.#inverseActive()) {
        this.#diffTracker.recordInverse(path, '$length', rawTarget.length);
      }
      rawTarget.length = rawSource.$length;
      getDiff().$length = rawSource.$length;
      hasChanges = true;
    }

    // A hole in a real-array source means the slot is empty: for-in
    // skipped it above, but the wholesale outcome leaves that slot empty,
    // so clear any element the target still holds there
    if (Array.isArray(rawTarget) && Array.isArray(rawSource)) {
      for (let i = 0; i < rawSource.length; i++) {
        if (!(i in rawSource) && i in rawTarget) {
          getDiff();
          this.#recordDeletion(rawTarget, String(i), path);
          delete rawTarget[i];
          hasChanges = true;
        }
      }
    }

    // Delete missing properties (unless in patch mode or target is array).
    // Wholesale context deletes even in patch mode: the source there is a
    // full value, and keys it doesn't carry are gone
    if ((!this.#patchMode || wholesale) && !Array.isArray(rawTarget)) {
      for (const prop in rawTarget) {
        if (Object.hasOwnProperty.call(rawTarget, prop) &&
          (rawSource[prop] === null || rawSource[prop] === undefined)) {
          // Track deletion in diff
          if (this.#inverseActive()) {
            this.#diffTracker.recordInverse(path, prop, rawTarget[prop]);
          }
          this.#recordLoss(path, prop, rawTarget[prop]);
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
   * @param {Array} path - Base path for external calls entering at a
   *   nested proxy, so the diff is recorded where the subtree lives
   */
  patch(target, source, path = []) {
    this.#patchMode = true;
    try {
      this.overwrite(target, source, path);
    } finally {
      this.#patchMode = false;
    }
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
