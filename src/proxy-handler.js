// proxy-handler.js - Handles proxy creation and management
import {Utils} from "./utils.js";

export const PROXY_TARGET = Symbol('LazyWatch.ProxyTarget');
export const LAZYWATCH_INSTANCE = Symbol('LazyWatch.Instance');

// Array methods that move elements: run on the raw array, so the objects
// themselves move and their handles with them, and recorded as one
// `$splice` op each. push/pop only touch the tail and go through the traps.
const STRUCTURAL_ARRAY_METHODS = new Set(['splice', 'unshift', 'shift']);

// Array methods that rearrange existing elements in place. sort and reverse
// permute: the elements move as by splice (see #rearrange). copyWithin
// copies, which state cannot do by reference (an object lives in one
// place), so it writes copies, index by index.
const REORDER_ARRAY_METHODS = new Set(['sort', 'reverse', 'copyWithin']);

// Sentinel for "this path no longer resolves in the watched tree"
const MISSING = Symbol('LazyWatch.Missing');

// The root's path, shared: paths handed out are never changed (see #pathOf)
const ROOT_PATH = Object.freeze([]);

/** Array.prototype.splice, without the limit on spread arguments */
function nativeSplice(target, start, deleteCount, items) {
  if (items.length < 10000) return Array.prototype.splice.call(target, start, deleteCount, ...items);
  const removed = target.slice(start, start + deleteCount);
  const tail = target.slice(start + deleteCount);
  target.length = start;
  for (const item of items) target.push(item);
  for (const value of tail) target.push(value);
  return removed;
}

/**
 * JSON with every object's keys sorted: equal content, equal string. A
 * hole reads as null, as JSON writes it
 */
function canonical(value) {
  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < value.length; i++) parts.push(i in value && value[i] !== undefined ? canonical(value[i]) : 'null');
    return '[' + parts.join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * The positions in `values` of a longest strictly increasing run (not
 * necessarily contiguous), in O(n log n)
 * @param {number[]} values
 * @returns {Set<number>}
 */
function longestIncreasing(values) {
  const tails = [];
  const previous = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i !== -1; i = previous[i]) out.add(i);
  return out;
}

export class ProxyHandler {
  #original;
  // Raw object -> { proxy, parent, key, self }: its one proxy (so identity
  // checks stay stable; made on first read), and where it was last put —
  // the container holding it and its key there. An object moves only by
  // the structural ops here, which update the link; everything else keeps
  // objects in place or copies them. A path is found by walking links up
  // to the root, checking at every step that the parent still holds the
  // object at that key: a handle follows its object wherever a splice or
  // sort takes it, and one whose object left the tree is detached.
  //
  // The link to the parent is a WeakRef (the parent's `self`, shared by its
  // children), so a handle kept on an object that left the tree keeps only
  // that object alive, not the containers it was in. Anything in the tree
  // is reachable from the root, so a link only clears once its parent is
  // out of the tree. Every record's parent has a record, up to the root.
  #records = new WeakMap();
  // Bumped whenever a container may have moved or left the tree (a splice,
  // a truncation, a container deleted, replaced, or put back, a rollback):
  // a path found at the current generation still holds (see #pathOf)
  #generation = 0;
  // While a diff is applied: objects its `$splice` ops took out, so an op
  // putting the same content back (a move, sent as out and in) puts the
  // object itself back and handles on it keep working (see #applySpliceOps)
  #pool = null;
  // While a transaction runs: every raw mutation, with what it replaced,
  // so a rollback undoes them exactly — the same objects back in the same
  // places, handles and listeners on them untouched (see rollbackLog)
  #log = null;
  #diffTracker;
  #eventEmitter;
  #patchMode = false;
  #instance = null;

  constructor(original, diffTracker, eventEmitter) {
    if (!Utils.isObjectOrArray(original)) {
      throw new TypeError('LazyWatch requires a plain object or array (Map, Set, Date, etc. cannot be deep-watched)');
    }
    Utils.assertSupported(original);
    // The constructor argument is kept by reference (everything entering
    // later is cloned), so frozen containers and exotic properties can
    // only arrive here — reject them before a write can fail mid-record
    Utils.assertTrackable(original);
    // State holds values as JSON carries them (see Utils.cloneValue)
    Utils.dropUndefined(original);
    this.#original = original;
    this.#diffTracker = diffTracker;
    this.#eventEmitter = eventEmitter;
  }

  /**
   * Create the root proxy
   */
  createRootProxy(lazyWatchInstance) {
    this.#instance = lazyWatchInstance;
    const proxy = this.#createProxy(this.#original, lazyWatchInstance);
    // Children of the root link to it strongly: it never leaves the tree,
    // and every handle keeps the instance, and so the root, alive anyway
    const original = this.#original;
    const self = { deref: () => original };
    this.#records.set(original, { proxy, parent: null, key: null, self, path: [], generation: -1 });
    return proxy;
  }

  /**
   * The proxy for `value`, just read at `parent[key]` (a container with a
   * record: it was read through its own proxy). Made on first read, with
   * its link; an object's link moves with it after that (see #relink)
   */
  #handleAt(value, parent, key) {
    let record = this.#records.get(value);
    if (!record) {
      record = { proxy: null, parent: this.#refTo(parent), key, self: null, path: null, generation: -1 };
      this.#records.set(value, record);
    }
    if (record.proxy === null) record.proxy = this.#createProxy(value, this.#instance);
    return record.proxy;
  }

  /**
   * The weak link children of `parent` share, or null when `parent` has no
   * record. Given the parent's path, the records it lacks on the way are
   * made first (an array a received diff moved an element into, say,
   * which nothing read through a proxy yet)
   */
  #refTo(parent, path = null) {
    let record = this.#records.get(parent);
    if (!record && path !== null) {
      this.#ensureRecords(path);
      record = this.#records.get(parent);
    }
    if (!record) return null;
    return record.self ??= new WeakRef(parent);
  }

  /** Records, with their links, for the containers along `path` */
  #ensureRecords(path) {
    let node = this.#original;
    for (const seg of path) {
      const child = node[seg];
      if (!Utils.isObjectOrArray(child)) return;
      if (!this.#records.has(child)) {
        this.#records.set(child, { proxy: null, parent: this.#refTo(node), key: seg, self: null, path: null, generation: -1 });
      }
      node = child;
    }
  }

  /**
   * Create a proxy for an object. Its traps find the object's path when
   * they need it (#attachedPath): the object may have moved since
   */
  #createProxy(obj, lazyWatchInstance) {
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

        // Intercept the methods that move elements (see STRUCTURAL_ARRAY_METHODS)
        if (Array.isArray(target) && STRUCTURAL_ARRAY_METHODS.has(prop) &&
          value === Array.prototype[prop]) {
          return (...args) => this.#structuralArrayOp(target, prop, args, receiver);
        }

        // Intercept reordering methods (see REORDER_ARRAY_METHODS)
        if (Array.isArray(target) && REORDER_ARRAY_METHODS.has(prop) &&
          value === Array.prototype[prop]) {
          return (...args) => this.#reorderArrayOp(target, prop, args, receiver);
        }

        if (Utils.isObjectOrArray(value)) {
          return this.#handleAt(value, target, prop);
        }

        return value;
      },

      set: (target, prop, value, receiver) =>
        this.#applySet(target, prop, value, receiver),

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
        return this.#applySet(target, prop, descriptor.value, this.#records.get(target).proxy);
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
        const path = this.#attachedPath(target);

        if (prop in target) {
          this.#recordDeletion(target, prop, path);
          this.#deleteRaw(target, prop);
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
    if (isArray) this.#setDiffLength(diff, target.length);
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
   * the emitter, which consults the live tree for the one diff shape that
   * cannot say whether a listener's object survived.
   * @returns {{ found: boolean, value?: * }}
   */
  valueAt(path) {
    const value = this.#valueAt(path);
    return value === MISSING ? { found: false } : { found: true, value };
  }

  /**
   * The path of a raw object in the tree, or null when it is no longer in
   * it: its links are walked up to the root, and every parent must still
   * hold the object at the recorded key. The answer is kept until a
   * container next moves or leaves the tree, so a run of writes that move
   * nothing finds it without the walk. Callers must not change the array
   */
  #pathOf(raw) {
    if (raw === this.#original) return ROOT_PATH;
    const record = this.#records.get(raw);
    if (record === undefined) return null;
    if (record.generation === this.#generation) return record.path;
    const path = this.#walkUp(raw);
    record.path = path;
    record.generation = this.#generation;
    return path;
  }

  /** #pathOf without the kept answer */
  #walkUp(raw) {
    const path = [];
    let node = raw;
    while (node !== this.#original) {
      const record = this.#records.get(node);
      if (!record || record.parent === null) return null;
      const parent = record.parent.deref();
      const key = record.key;
      if (parent === undefined || !Object.hasOwn(parent, key) || parent[key] !== node) return null;
      path.push(key);
      node = parent;
    }
    return path.reverse();
  }

  /**
   * Where a raw object (or a proxy's) is in the tree, or null when it is
   * detached; for the emitter (listeners follow their objects) and the
   * static API
   */
  locate(value) {
    return this.#pathOf(this.resolveIfProxy(value));
  }

  /**
   * Where the object was last seen: its links, unchecked. For messages
   */
  #lastKnownPath(raw) {
    const path = [];
    let node = raw;
    for (let depth = 0; node !== this.#original && depth < 1000; depth++) {
      const record = this.#records.get(node);
      const parent = record?.parent?.deref();
      if (parent === undefined) break;
      path.push(record.key);
      node = parent;
    }
    return path.reverse();
  }

  /**
   * The path of the object a tracked write goes to. A handle follows its
   * object wherever structural array ops move it; one whose object left
   * the tree — deleted, replaced, truncated away, spliced out and not put
   * back — would mutate an object no replica can see, so the write fails
   * loudly instead. (Putting the object back reattaches the handle.)
   */
  #attachedPath(raw) {
    const path = this.#pathOf(raw);
    if (path === null) throw this.#detachedError(raw);
    return path;
  }

  #detachedError(raw) {
    return new Error(
      `LazyWatch proxy is detached: its object left the watched tree (last at "${this.#lastKnownPath(raw).join('.')}"). Re-read it from the root proxy, or put it back into the tree.`
    );
  }

  /**
   * Whether an assigned or inserted value is an object of this tree that
   * has left it: such an object is put back itself rather than copied, so
   * its handles work again, as a plain object would be moved
   */
  #isDetached(raw) {
    return raw !== this.#original && this.#records.has(raw) && this.#pathOf(raw) === null;
  }

  /** Point the link of the object now at `parent[key]` there */
  #relinkAt(parent, key) {
    const record = this.#records.get(parent[key]);
    if (!record) return;
    const ref = this.#refTo(parent);
    if (ref === null) return;
    record.parent = ref;
    record.key = key;
  }

  /**
   * Point the links of the elements from `from` on at their new indices
   * (after an op moved them); objects without a record have no handle yet.
   * `path` is the array's, for a record it may lack (see #refTo)
   */
  #relink(target, from, to = target.length, path = null) {
    let ref = null;
    for (let i = from; i < to; i++) {
      const value = target[i];
      if (!Utils.isObjectOrArray(value)) continue;
      const record = this.#records.get(value);
      if (!record) continue;
      ref ??= this.#refTo(target, path);
      if (ref === null) return;
      record.parent = ref;
      record.key = String(i);
    }
  }

  /**
   * The `set` trap body, shared with the defineProperty trap: validates the
   * value, records the change (or deletion, for undefined) in the diff, and
   * applies it to the target.
   */
  #applySet(target, prop, value, receiver) {
    // Symbol-keyed properties are local-only metadata: stored on the
    // target but never recorded, emitted, or synced (JSON cannot carry
    // them anyway). They are also exempt from value validation, since
    // their values never reach the wire.
    if (typeof prop === 'symbol') {
      target[prop] = this.resolveIfProxy(value);
      return true;
    }

    const path = this.#attachedPath(target);

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
        this.#deleteRaw(target, prop);
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

    // A handle's object put back at the end (push, or an assignment at
    // `length`) goes in as splice puts it, as one `$splice` op: a move out
    // and back in stays a move, which listeners hear nothing of and a
    // receiver makes with its own object. (An index write would carry the
    // object whole, and put a copy in on the receiver.) push's own
    // `length` write that follows is then a no-op
    if (valueIsObject && Array.isArray(target) && prop === String(target.length) &&
      this.#isDetached(value)) {
      this.#spliceRaw(target, path, target.length, 0, this.#placeable([value]));
      return true;
    }

    // Merge same-kind container writes: object over object, and array over
    // array (element-wise, recording a minimal array fragment instead of
    // the wholesale value). A kind change — a real array over a plain
    // object, or a plain object over an array — replaces wholesale below:
    // merging would leave an object with index keys, or an array carrying
    // the object's keys as junk properties. (An assigned object is never
    // an array fragment: the wire format's markers are reserved names that
    // cannot enter state.) An assigned value is a full value, so the merge
    // runs in wholesale mode: it must delete what the value doesn't carry
    // even during patch application.
    const sameKind = Array.isArray(currentValue) === Array.isArray(value);
    if (currentIsObject && valueIsObject && sameKind) {
      this.overwrite(receiver[prop], value, [...path, prop], true, true);
    } else if (currentValue !== value) {
      this.#recordChange(target, prop, value, path);
    }

    return true;
  }

  /**
   * Intercepted sort/reverse/copyWithin on a watched array.
   *
   * The final arrangement is computed natively on a copy of the raw
   * elements, so a throwing sort comparator leaves state untouched. sort
   * and reverse then move the elements themselves to it (#rearrange):
   * handles follow, and the batch records the moves as `$splice` ops.
   * copyWithin copies elements, which state holds by value only, and an
   * array with holes has no op that moves a hole: those write the
   * relocated values index by index, as copies, through the proxy. Note
   * that a sort comparator sees raw elements, not proxies — reads behave
   * identically, and comparators must not mutate.
   */
  #reorderArrayOp(target, method, args, receiver) {
    const path = this.#attachedPath(target);
    const copy = target.slice();
    Array.prototype[method].apply(copy, args);

    let holes = false;
    for (let i = 0; i < target.length && !holes; i++) holes = !(i in target);
    if (method !== 'copyWithin' && !holes) {
      this.#rearrange(target, path, copy);
      return receiver;
    }

    const writes = [];
    for (let i = 0; i < copy.length; i++) {
      if (target[i] !== copy[i] || (i in target) !== (i in copy)) {
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
   * Move the elements of `target` into the order of `next`, a permutation
   * of them: the longest run already in order stays, the rest are spliced
   * out and back in at their places, so the objects themselves move (and
   * are recorded as ops, like any splice). Equal primitives are
   * interchangeable and matched in order.
   */
  #rearrange(target, path, next) {
    const objects = new Map();
    const primitives = new Map();
    for (let i = 0; i < target.length; i++) {
      const value = target[i];
      if (Utils.isObjectOrArray(value)) objects.set(value, i);
      else if (primitives.has(value)) primitives.get(value).push(i);
      else primitives.set(value, [i]);
    }
    const from = next.map(value => Utils.isObjectOrArray(value) ? objects.get(value) : primitives.get(value).shift());
    const keep = longestIncreasing(from);
    if (keep.size === next.length) return;
    const stays = new Set();
    for (const j of keep) stays.add(from[j]);

    // Out: every element that moves, runs from the end so indices hold
    let first = target.length;
    for (let i = target.length - 1; i >= 0; i--) {
      if (stays.has(i)) continue;
      let start = i;
      while (start > 0 && !stays.has(start - 1)) start--;
      this.#spliceRaw(target, path, start, i - start + 1, [], false);
      first = start;
      i = start;
    }
    // In: each at its place in the new order, runs from the front; what
    // precedes a place is already there
    for (let j = 0; j < next.length; j++) {
      if (keep.has(j)) continue;
      let end = j;
      while (end + 1 < next.length && !keep.has(end + 1)) end++;
      this.#spliceRaw(target, path, j, 0, next.slice(j, end + 1), false);
      first = Math.min(first, j);
      j = end;
    }
    // Every element from the first that moved has its final index now
    this.#relink(target, first, target.length, path);
  }

  /** Diff node for a path */
  #diff(path) {
    return this.#diffTracker.getDiffObject(path);
  }

  #scheduleEmit() {
    this.#eventEmitter.scheduleEmit();
  }

  /** True when pre-change values should be captured for the inverse diff */
  #inverseActive() {
    return this.#diffTracker.inverseEnabled;
  }

  /**
   * Remember a container destroyed this batch (deleted, replaced by a
   * leaf, or truncated away). If the slot is recreated as an object later
   * in the same batch, #staleFilledDiffValue null-fills the recreation's
   * diff so receivers delete the stale keys they still hold.
   */
  #recordLoss(path, prop, value) {
    if (Utils.isObjectOrArray(value)) {
      this.#diffTracker.recordContainerLoss(
        path, prop, value, this.#diffTracker.peekDiffObject([...path, prop]));
    }
  }

  /**
   * The value to record in the diff for a wholesale write at path+prop.
   *
   * Always the diff's own copy, never the object that lands in state: a
   * diff node aliased to a live container would receive the bookkeeping
   * of same-batch writes below it (`$length` stamps, null markers) as
   * real properties of the state. Leaves need no copy.
   *
   * When a container was destroyed at this slot earlier in the batch (or
   * `stale` is passed directly by a replacement site), receivers still
   * hold it — a plain object recorded here would merge into it instead of
   * replacing it. The copy then records null for every stale key the new
   * value doesn't carry (recursing through shared plain-object keys), so
   * applying the diff deletes them; the null markers belong on the wire,
   * never in local state. Arrays need no filling — receivers apply real
   * arrays wholesale — and neither does an object replacing an array:
   * receivers replace those wholesale too.
   */
  #staleFilledDiffValue(clonedValue, path, prop, stale) {
    if (!Utils.isObjectOrArray(clonedValue)) {
      return clonedValue;
    }
    const copy = Utils.deepClone(clonedValue);
    // The batch's first loss wins over a same-call replacement: receivers
    // are at the pre-batch state
    const loss = this.#diffTracker.getContainerLoss(path, prop) ??
      (Utils.isObjectOrArray(stale) ? { container: stale, node: undefined } : undefined);
    if (loss) {
      this.#nullFillStale(copy, loss.container, loss.node, [...path, prop]);
    }
    return copy;
  }

  /**
   * Record null in `diffValue` for every key receivers may still hold
   * that it doesn't carry. Two sources describe what they hold: the
   * container destroyed at the slot earlier this batch (its keys as they
   * were then), and the diff node it had at loss time (keys the batch had
   * already deleted — gone from the container, remembered only as null
   * markers — and keys it had written). A marker for a key receivers
   * never had is a harmless no-op, so every key of either source counts.
   * Sources of the other kind are ignored: a kind change is replaced
   * wholesale by receivers and needs no filling.
   *
   * Recurses through same-kind containers: object elements of a real
   * array are full values too, and a nested listener under one cannot
   * tell a full value from a fragment, so they carry their own markers
   * (receivers applying the array wholesale drop them). Array slots
   * missing from the new array need no marker — its length truncates them.
   */
  #nullFillStale(diffValue, container, node, path) {
    const wantArray = Array.isArray(diffValue);
    const stale = Utils.isObjectOrArray(container) && Array.isArray(container) === wantArray
      ? container : undefined;
    let recorded;
    if (Utils.isObjectOrArray(node)) {
      const nodeIsArray = Array.isArray(node) || Utils.hasArrayMarker(node);
      if (nodeIsArray === wantArray) recorded = node;
    }
    if (!stale && !recorded) return;

    if (wantArray) {
      for (let i = 0; i < diffValue.length; i++) {
        this.#nullFillStaleChild(diffValue, stale, recorded, path, String(i));
      }
      return;
    }
    const keys = new Set(stale ? Object.keys(stale) : []);
    if (recorded) {
      for (const key of Object.keys(recorded)) {
        if (!Utils.isReservedDiffKey(key)) keys.add(key);
      }
    }
    for (const key of keys) {
      if (Utils.isUnsafeKey(key)) continue;
      if (!(key in diffValue)) {
        diffValue[key] = null;
      } else {
        this.#nullFillStaleChild(diffValue, stale, recorded, path, key);
      }
    }
  }

  /**
   * Recurse into one key. What receivers hold there is the batch's first
   * loss recorded at (or above) that path when any — a key deleted from
   * the stale container earlier in the batch is gone from it, and even
   * one still present may have been replaced since the batch started —
   * and the sources' own children otherwise.
   */
  #nullFillStaleChild(diffValue, stale, recorded, path, key) {
    const child = diffValue[key];
    if (!Utils.isObjectOrArray(child)) return;
    const loss = this.#diffTracker.getContainerLoss(path, key);
    const container = loss ? loss.container : (stale ? stale[key] : undefined);
    const node = loss ? loss.node : (recorded ? recorded[key] : undefined);
    this.#nullFillStale(child, container, node, [...path, key]);
  }

  /** Start logging raw mutations (LazyWatch.transaction) */
  beginLog() {
    this.#log = [];
  }

  /** Stop logging */
  endLog() {
    this.#log = null;
  }

  /**
   * Undo every mutation since beginLog, newest first, without recording
   * or emitting anything: each write puts back what it replaced, each
   * splice the elements it removed. The objects themselves return to
   * their places, so handles and listeners on them never notice.
   * LazyWatch.transaction() on failure
   */
  rollbackLog() {
    const log = this.#log;
    this.#log = null;
    this.#generation++;
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry[0] === 'splice') {
        const [, target, start, removed, inserted, path] = entry;
        nativeSplice(target, start, inserted, removed);
        for (let k = 0; k < removed.length; k++) {
          if (!(k in removed)) delete target[start + k];
        }
        this.#relink(target, start, target.length, path);
      } else if (entry[0] === 'length') {
        const [, target, length, tail] = entry;
        const from = Math.min(target.length, length);
        target.length = length;
        for (const [i, value] of tail) target[i] = value;
        this.#relink(target, from);
      } else {
        const [, target, key, had, prev] = entry;
        if (had) {
          target[key] = prev;
          this.#relinkAt(target, key);
        } else {
          delete target[key];
        }
      }
    }
  }

  /** `target[key] = value`, logged in a transaction */
  #setRaw(target, key, value) {
    if (Utils.isObjectOrArray(target[key]) || Utils.isObjectOrArray(value)) this.#generation++;
    if (this.#log) {
      // A write past the end of an array grows it too
      if (Array.isArray(target) && /^\d+$/.test(key) && Number(key) >= target.length) {
        this.#log.push(['length', target, target.length, []]);
      }
      this.#log.push(['set', target, key, Object.hasOwn(target, key), target[key]]);
    }
    target[key] = value;
  }

  /** `delete target[key]`, logged in a transaction */
  #deleteRaw(target, key) {
    if (Utils.isObjectOrArray(target[key])) this.#generation++;
    this.#log?.push(['set', target, key, Object.hasOwn(target, key), target[key]]);
    delete target[key];
  }

  /**
   * Intercepted splice/unshift/shift on a watched array.
   *
   * The elements themselves move, as in a plain array: a handle read
   * before the op still addresses the same object afterwards, at its new
   * index (#spliceRaw relinks it). The batch records one `$splice` op,
   * whatever it wrote to the array before (see DiffTracker.recordSplice),
   * and its inverse one op that undoes it.
   *
   * An inserted value is copied, as any value entering state — except a
   * handle whose object left the tree (spliced out, say): that object
   * itself goes back in, so `list.splice(j, 0, ...list.splice(i, 1))`
   * moves an element and its handles keep working. What splice and shift
   * return are the removed elements' handles, detached until put back.
   */
  #structuralArrayOp(target, method, args, receiver) {
    const path = this.#attachedPath(target);
    const len = target.length;

    // Inserted items are full values landing in state, so validate them
    // before anything mutates
    const inserted = method === 'splice' ? args.slice(2)
      : method === 'unshift' ? args
      : [];
    if (inserted.length) {
      const itemPath = [...path, method];
      for (const item of inserted) {
        Utils.assertSupported(this.resolveIfProxy(item), itemPath);
      }
    }

    // Normalize the call into one splice op: [start, deleteCount, items]
    let start = 0;
    let deleteCount = 0;
    if (method === 'shift') {
      deleteCount = Math.min(1, len);
    } else if (method === 'splice') {
      [start, deleteCount] = this.#spliceRange(len, args);
    }

    if (deleteCount === 0 && inserted.length === 0) {
      return method === 'unshift' ? len : method === 'shift' ? undefined : [];
    }

    const removed = this.#spliceRaw(target, path, start, deleteCount, this.#placeable(inserted));
    if (method === 'unshift') return target.length;
    // A removed object's handle: its link still names the place it left,
    // which no longer holds it, so it is detached until put back
    const handles = removed.map((value, i) =>
      Utils.isObjectOrArray(value) ? this.#handleAt(value, target, String(start + i)) : value);
    return method === 'shift' ? handles[0] : handles;
  }

  /**
   * A splice call's start and delete count, clamped as the native method
   * clamps them
   */
  #spliceRange(len, args) {
    const rel = args.length ? Math.trunc(args[0]) || 0 : 0;
    const start = rel < 0 ? Math.max(len + rel, 0) : Math.min(rel, len);
    let deleteCount = 0;
    if (args.length === 1) {
      deleteCount = len - start;
    } else if (args.length > 1) {
      deleteCount = Math.min(Math.max(Math.trunc(args[1]) || 0, 0), len - start);
    }
    return [start, deleteCount];
  }

  /**
   * What inserted values land in state as: copies, except the object of a
   * handle that has left the tree, which goes back itself (once per call:
   * a second occurrence is a copy). `undefined` goes in as the `null` the
   * op carries on the wire (a hole spread into the call is one)
   */
  #placeable(values) {
    const used = new Set();
    return values.map(value => {
      const raw = this.resolveIfProxy(value);
      if (!Utils.isObjectOrArray(raw)) return raw === undefined ? null : raw;
      if (!used.has(raw) && this.#isDetached(raw)) {
        used.add(raw);
        this.#diffTracker.freezeLosses();
        return raw;
      }
      return Utils.cloneValue(raw);
    });
  }

  /**
   * One splice on a raw array: the elements themselves move, and every
   * handle on one is relinked to its new index. Recorded as one `$splice`
   * op carrying copies of `items`, and in the inverse as the op undoing it. `items` land in state as given (see
   * #placeable). Returns the removed elements. `relink` false leaves the
   * links to the caller, which moves many elements at once (#rearrange)
   */
  #spliceRaw(target, path, start, deleteCount, items, relink = true) {
    const newLength = target.length - deleteCount + items.length;
    // Before anything moves: the inverse copies what the op removes
    this.#diffTracker.recordInverseSplice(path, target, start, deleteCount, items.length);
    this.#diffTracker.recordSplice(path, start, deleteCount,
      items.map(item => Utils.isObjectOrArray(item) ? Utils.deepClone(item) : item), newLength, target);
    this.#generation++;
    const removed = nativeSplice(target, start, deleteCount, items);
    this.#log?.push(['splice', target, start, removed, items.length, path]);
    // Shifted elements took new indices; with no shift only the inserted
    // ones are new at theirs
    if (relink) this.#relink(target, start, deleteCount === items.length ? start + items.length : target.length, path);
    this.#scheduleEmit();
    return removed;
  }

  /**
   * Apply received $splice ops to a target array, as local splices: the
   * elements move and the ops are recorded, so relaying mirrors re-emit
   * them. An op's items are data, so they are copied; but an item with the
   * content of an object an earlier op of the same diff took out puts that
   * object back instead — a move arrives as an op out and an op in, and
   * handles on the moved object keep working (see #pool).
   */
  #applySpliceOps(rawTarget, ops, path) {
    for (const op of ops) {
      if (!Array.isArray(op)) continue;
      const [start, deleteCount] = this.#spliceRange(rawTarget.length, [op[0], op[1]]);
      const items = (Array.isArray(op[2]) ? op[2] : []).map(item => this.#fromPool(item));
      if (deleteCount === 0 && items.length === 0) continue;
      const removed = this.#spliceRaw(rawTarget, path, start, deleteCount, items);
      if (this.#pool) {
        for (const value of removed) {
          if (Utils.isObjectOrArray(value)) this.#pool.raws.push(value);
        }
      }
    }
  }

  /**
   * An op item as it lands in state: an object the diff took out with the
   * same content (matched by canonical JSON, each object at most once), or
   * a copy
   */
  #fromPool(item) {
    item = this.resolveIfProxy(item);
    if (!Utils.isObjectOrArray(item)) return item === undefined ? null : item;
    const pool = this.#pool;
    if (pool) {
      for (const raw of pool.raws.splice(0)) {
        const key = canonical(raw);
        if (pool.byKey.has(key)) pool.byKey.get(key).push(raw);
        else pool.byKey.set(key, [raw]);
      }
      if (pool.byKey.size > 0) {
        const key = canonical(item);
        const matches = pool.byKey.get(key);
        while (matches && matches.length > 0) {
          const raw = matches.shift();
          if (matches.length === 0) pool.byKey.delete(key);
          if (this.#isDetached(raw)) {
            this.#diffTracker.freezeLosses();
            return raw;
          }
        }
      }
    }
    return Utils.cloneValue(item);
  }


  /**
   * When an array is truncated, drop pending diff entries for indices
   * beyond the new length — they would be trimmed by the receiver anyway
   */
  #handleArrayLengthChange(target, newLength, path) {
    if (newLength < target.length) {
      // Truncation destroys elements; capture them (holes excluded) so the
      // inverse can restore them, and record container losses so a
      // same-batch recreation at those indices null-fills its diff.
      // Growth records nothing here. After the batch's $splice ops, the
      // inverse also needs the tail back before it undoes them (see
      // DiffTracker.recordInverseTruncation)
      if (this.#inverseActive()) {
        this.#diffTracker.recordInverseTruncation(path, target, newLength);
      }
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

  /** `target.length = value`, logged in a transaction */
  #setLength(target, value) {
    if (value < target.length) this.#generation++;
    if (this.#log && value !== target.length) {
      const tail = [];
      for (let i = value; i < target.length; i++) if (i in target) tail.push([i, target[i]]);
      this.#log.push(['length', target, target.length, tail]);
    }
    target.length = value;
  }

  /**
   * Record a change in the diff
   */
  #recordChange(target, prop, value, path) {
    const diff = this.#diff(path);

    // An array's `length` is recorded in the diff under the wire format's
    // `$length` marker; `length` on a plain object is ordinary data
    const isArrayLength = Array.isArray(target) && prop === 'length';
    const isArrayIndex = Array.isArray(target) && !isArrayLength && /^\d+$/.test(String(prop));

    // Only clone if it's an object/array. The object of a handle that left
    // the tree is put back itself, not copied (as a plain object would be
    // moved), so its handles work again; the diff still gets its own copy
    const reattach = Utils.isObjectOrArray(value) && this.#isDetached(value);
    const clonedValue = Utils.isObjectOrArray(value) ? Utils.cloneValue(value) : value;

    // Capture pre-change values before the writes below (inverse diffs are
    // wire fragments, so they carry the same $length marker)
    if (this.#inverseActive()) {
      this.#diffTracker.recordInverse(
        path, isArrayLength ? '$length' : prop, prop in target ? target[prop] : undefined, clonedValue);
      if (isArrayIndex) {
        this.#diffTracker.recordInverse(path, '$length', target.length);
      }
      // A write past the end grows the array (see recordInverseGrowth)
      const grownTo = isArrayLength ? value : isArrayIndex ? Number(prop) + 1 : 0;
      this.#diffTracker.recordInverseGrowth(path, target, grownTo);
    }

    if (isArrayLength) {
      this.#setDiffLength(diff, value);
      this.#setLength(target, value);
      this.#scheduleEmit();
      return;
    }

    // A container replaced wholesale — by a leaf, or by a container of the
    // other kind — is destroyed from the receivers' point of view;
    // remember it so this write, or a same-batch recreation, null-fills
    this.#recordLoss(path, prop, target[prop]);

    // The diff gets its own copy (see #staleFilledDiffValue)
    diff[prop] = this.#staleFilledDiffValue(clonedValue, path, prop);
    if (reattach) {
      this.#diffTracker.freezeLosses();
      this.#setRaw(target, prop, value);
      this.#relinkAt(target, prop);
    } else {
      this.#setRaw(target, prop, clonedValue);
    }

    // Array fragments always carry `$length`, so receivers can tell them
    // apart from plain objects even when the field doesn't exist on their
    // side. (push() never records length itself: the index assignment
    // auto-updates it, making the explicit set a no-op.)
    if (isArrayIndex) {
      this.#setDiffLength(diff, target.length);
    }

    this.#scheduleEmit();
  }

  /**
   * Record an array's length on its diff node. A node is normally a
   * fragment (plain object) carrying the `$length` marker — but when the
   * array itself was assigned wholesale earlier in the batch, its node is
   * the diff's own real-array copy, whose length IS the marker: real
   * arrays are full values on the wire, and receivers ignore `$length`
   * on them.
   */
  #setDiffLength(diff, length) {
    if (Array.isArray(diff)) {
      diff.length = length;
      return;
    }
    // Growth past the length recorded so far leaves a gap of slots this
    // batch never wrote: elements the array was truncated down past
    // earlier in the batch, or holes from a sparse write. Receivers may
    // still hold elements there, so the gap is deleted explicitly.
    if (typeof diff.$length === 'number') {
      for (let i = diff.$length; i < length; i++) {
        if (!(i in diff)) diff[i] = null;
      }
    }
    diff.$length = length;
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
      // The subtree's path now; an external call entering through a
      // detached nested proxy would record its diff where the object no
      // longer is
      path = this.#attachedPath(this.resolveIfProxy(target));
      if (this.#pool === null) {
        // Objects this diff's ops take out, for its ops putting them back
        this.#pool = { raws: [], byKey: new Map() };
        try {
          this.overwrite(target, source, path, true, wholesale);
        } finally {
          this.#pool = null;
        }
        return;
      }
    }

    // Get the target object (resolve proxy if needed)
    const rawTarget = this.resolveIfProxy(target);
    const rawSource = this.resolveIfProxy(source);
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
      // The node first: it records the length the batch found
      const node = getDiff();
      this.#handleArrayLengthChange(rawTarget, rawSource.length, path);
      if (this.#inverseActive()) {
        this.#diffTracker.recordInverse(path, '$length', rawTarget.length);
        this.#diffTracker.recordInverseGrowth(path, rawTarget, rawSource.length);
      }
      this.#setLength(rawTarget, rawSource.length);
      this.#setDiffLength(node, rawSource.length);
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
          this.#deleteRaw(rawTarget, prop);
          hasChanges = true;
        }
      } else if (Utils.isObjectOrArray(rawTarget[prop]) && Utils.isObjectOrArray(rawSource[prop]) &&
        Utils.canMerge(rawTarget[prop], rawSource[prop], wholesale)) {
        // Merge containers instead of replacing them, so the recorded diff
        // carries only real differences; kind mismatches fall through to
        // the replacement branch below (see Utils.canMerge)
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
            this.#diffTracker.recordInverseGrowth(path, rawTarget, Number(prop) + 1);
          }
        }
        this.#recordLoss(path, prop, prevValue);
        // The diff copy null-fills stale keys receivers still hold (from a
        // container destroyed earlier this batch, or replaced right here)
        getDiff()[prop] = this.#staleFilledDiffValue(clonedValue, path, prop, prevValue);
        this.#setRaw(rawTarget, prop, clonedValue);
        // Keep array fragments self-describing (see #recordChange).
        if (Array.isArray(rawTarget) && /^\d+$/.test(String(prop))) {
          this.#setDiffLength(getDiff(), rawTarget.length);
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
      // Same bookkeeping as a `length` assignment through the trap:
      // truncated elements are captured for the inverse and recorded as
      // container losses, and stale diff indices are trimmed
      const node = getDiff();
      this.#handleArrayLengthChange(rawTarget, rawSource.$length, path);
      if (this.#inverseActive()) {
        this.#diffTracker.recordInverse(path, '$length', rawTarget.length);
        this.#diffTracker.recordInverseGrowth(path, rawTarget, rawSource.$length);
      }
      this.#setLength(rawTarget, rawSource.$length);
      this.#setDiffLength(node, rawSource.$length);
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
          this.#deleteRaw(rawTarget, String(i));
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
          this.#deleteRaw(rawTarget, prop);
          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      this.#scheduleEmit();
    }
  }

  /**
   * Patch (merge without deleting missing properties); the diff is
   * recorded where the target (a nested proxy, say) is now
   */
  patch(target, source) {
    this.#patchMode = true;
    try {
      this.overwrite(target, source);
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
   * Clean up resources
   */
  dispose() {
    this.#records = new WeakMap();
    this.#pool = null;
  }
}
