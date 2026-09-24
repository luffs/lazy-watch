// diff-tracker.js - Handles diff tracking
import {Utils} from "./utils.js";

const INDEX_RE = /^\d+$/;

// What takeCarried hands out when a batch carried nothing (never written to)
const NOTHING_CARRIED = new Map();

/**
 * Where a position after a run of splices was before them: back through
 * each op in reverse, or null when one of them inserted it.
 * @param {Array} ops - `$splice` ops, oldest first
 * @param {number} index
 * @returns {number|null}
 */
function indexBefore(ops, index) {
  for (let i = ops.length - 1; i >= 0; i--) {
    const [start, deleteCount, items] = ops[i];
    const inserted = Array.isArray(items) ? items.length : 0;
    if (index < start) continue;
    if (index < start + inserted) return null;
    index = index - inserted + deleteCount;
  }
  return index;
}

/**
 * Where `path` — a position in the tree once `diff` is applied — was
 * before it: every array index on the way is mapped back through the
 * `$splice` ops the diff applies to that array. Null when the path runs
 * through an element one of those ops inserted. (An array the diff
 * carries whole has no ops: its indices map to themselves.)
 *
 * Forward diffs keep their index keys in post-op positions (see
 * DiffTracker.recordSplice), so the walk down the diff follows `path` as
 * given while the result collects the mapped positions.
 * @param {Object} diff - A forward diff (or the pending one)
 * @param {Array<string>} path
 * @returns {Array<string>|null}
 */
export function preBatchPath(diff, path) {
  let node = diff;
  let out = null;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    let key = seg;
    if (Utils.isPlainObject(node) && Array.isArray(node.$splice) && INDEX_RE.test(seg)) {
      const before = indexBefore(node.$splice, Number(seg));
      if (before === null) return null;
      key = String(before);
    }
    if (key !== seg && out === null) out = path.slice(0, i);
    if (out !== null) out.push(key);
    node = Utils.isObjectOrArray(node) ? node[seg] : undefined;
  }
  return out ?? path;
}

/**
 * Move the index keys of an array's diff node the way a splice moves the
 * elements they describe: kept before the op, dropped with the elements
 * it removes, shifted after it. Receivers apply a node's `$splice` ops
 * before its other keys, so keys written before the op must name the
 * positions their elements hold after it.
 */
function spliceIndexKeys(node, start, deleteCount, inserted) {
  const shift = inserted - deleteCount;
  const moved = [];
  for (const key of Object.keys(node)) {
    if (!INDEX_RE.test(key)) continue;
    const index = Number(key);
    if (index < start) continue;
    const value = node[key];
    delete node[key];
    if (index >= start + deleteCount) moved.push([index + shift, value]);
  }
  for (const [index, value] of moved) node[index] = value;
}

export class DiffTracker {
  #masterDiff = {};
  #masterInverse = {};
  // Inverse nodes that are full clones of a replaced container. A clone
  // is a complete record: nothing below it needs recording (restoring it
  // restores everything), and no later bookkeeping for whatever now lives
  // at that path — possibly a container of another kind — may land on it.
  // Only null-fill against later replacements still applies (keys the new
  // value introduces must be deleted on undo).
  #completeInverse = new WeakSet();
  // Containers destroyed this batch (deleted, replaced by a leaf, or
  // truncated away), keyed by their path. If the same slot is recreated as
  // an object later in the batch, the recreation overwrites the recorded
  // null/leaf in the diff — receivers would merge the new object into
  // their still-live stale container. The stale container is kept here so
  // the recreation's diff value can be null-filled (stale keys recorded as
  // null, recursively), making the diff delete what receivers still hold.
  // First loss wins: receivers are at the pre-batch state. Values are the
  // detached containers themselves — nothing mutates them while detached
  // (writes through a detached handle throw), and putting one back into
  // the tree first turns the records into copies (freezeLosses). Keyed by
  // position, so a splice moves them (#spliceLosses).
  #lostContainers = new Map();
  // Object -> the diff fragments of it that left the diff with it this
  // batch, taken out by $splice ops (see recordSplice) or lost with it
  // (recordContainerLoss), and the same for the last batch consumed,
  // until the emitter takes them (takeCarried). Made when needed
  #carried = null;
  #consumedCarried = null;
  // Array diff node -> the array's length when the batch began, and the
  // length receivers' copy has after the node's ops so far (recordSplice).
  // Made when needed
  #baseLength = null;
  #received = null;

  // When true, an inverse diff (the patch that undoes the batch) is recorded
  // alongside the forward diff. Opt-in: set from the `inverse` constructor
  // option, and temporarily by LazyWatch.transaction().
  inverseEnabled = false;

  // The live watched tree, walked alongside a path so diff nodes that
  // stand for arrays can be stamped with `$length` as they are created
  #root;

  /**
   * @param {Object|Array} root - The watched object (kept by reference)
   */
  constructor(root) {
    this.#root = root;
  }

  /**
   * Get or create a nested diff object at the given path.
   *
   * Every node created for an array — the target of the write and every
   * array ancestor on the way down — is stamped with the array's current
   * `$length`, so array nodes are self-describing on the wire even when
   * only something below them changed. Receivers rely on the marker to
   * tell an array fragment (merge) from a plain object replacing an array
   * (which carries no marker). Length-changing ops on the array itself
   * keep the stamp current.
   */
  getDiffObject(path = []) {
    let node = this.#masterDiff;
    let live = this.#root;
    // The root's kind is fixed for the instance's life
    if (Array.isArray(live) && typeof node.$length !== 'number') (this.#baseLength ??= new WeakMap()).set(node, live.length);
    this.#stampLength(node, live);
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      live = Utils.isObjectOrArray(live) ? live[seg] : undefined;
      if (!node[seg]) {
        node = node[seg] = {};
        // Stamp only nodes created here: a node is created for a path
        // whose own value has not been recorded this batch, so the live
        // value there is the batch-start value and its kind is the kind
        // the node describes. An existing node is never re-stamped.
        this.#stampLength(node, live);
        if (Array.isArray(live)) (this.#baseLength ??= new WeakMap()).set(node, live.length);
      } else {
        node = node[seg];
      }
    }
    return node;
  }

  /**
   * A node created for a deeper write records the length as it stands
   * then, and every later length change on the array itself restates it.
   * In the inverse that makes the stamp the pre-batch length, since any
   * earlier length change would already have recorded one.
   */
  #stampLength(node, live) {
    // A real array in the diff (assigned wholesale this batch) is a full
    // value: its own length is the marker, and receivers ignore `$length`
    // on real arrays anyway
    if (Array.isArray(live) && !Array.isArray(node) && typeof node.$length !== 'number') {
      node.$length = live.length;
    }
  }

  /**
   * Record the pre-change value of `prop` at `path` into the inverse diff.
   *
   * The inverse is a patch fragment: applying it to the post-batch state
   * (with patch semantics, where null deletes) restores the pre-batch state.
   * Three rules keep it correct across a whole batch:
   *
   * - First write wins: the recorded value for a key is the one from before
   *   the first change in the batch; later changes to the same key are
   *   ignored.
   * - Gap-fill: when a container is deleted or replaced wholesale after some
   *   of its keys were already recorded, its remaining keys are backfilled
   *   from the live value (still pre-change for exactly those keys).
   * - Null-fill: when a container value replaces another, keys the new value
   *   introduces are recorded as null, so undo deletes them.
   *
   * @param {Array} path - Path of the node containing prop
   * @param {string} prop - Property being changed
   * @param {*} prev - Value before the change; undefined = property was absent
   * @param {*} [next] - Value after the change; undefined = deletion
   */
  recordInverse(path, prop, prev, next) {
    if (!this.inverseEnabled) return;
    // The inverse speaks in pre-batch positions: undo applies its `$splice`
    // ops first, which put every element back where the batch found it,
    // and only then its keys. A position one of the batch's ops inserted
    // has nothing to restore: undoing that op removes it
    const before = preBatchPath(this.#masterDiff, [...path, prop]);
    if (before === null) return;
    prop = before[before.length - 1];
    const found = this.#inverseNode(path, before.slice(0, -1));
    if (found === null) return; // covered by a recorded ancestor value
    const { node, complete, live } = found;

    if (complete) {
      // Below a complete record the pre-batch values are all captured, but
      // undo applies it with merge semantics onto the post-batch state: a
      // key it does not carry is new since the batch started and must be
      // recorded as null so undo deletes it. Unless the batch has put a
      // container of the other kind there — undo then replaces it
      // wholesale, and an object key would only corrupt an array fragment
      // (or the reverse)
      if (Utils.hasArrayMarker(node) !== Array.isArray(live)) return;
      if (!(prop in node)) {
        node[prop] = null;
      } else if (Utils.isObjectOrArray(node[prop]) && Utils.isObjectOrArray(next)) {
        // A recorded container replaced by a new one of the same kind:
        // keys the new value introduces must be deleted on undo too
        this.#nullFill(node[prop], next);
      }
      return;
    }

    const prevMissing = prev === undefined;
    if (!(prop in node)) {
      node[prop] = prevMissing
        ? null
        : (Utils.isObjectOrArray(prev) ? Utils.deepClone(prev) : prev);
      if (!prevMissing && Utils.isObjectOrArray(node[prop])) {
        this.#completeInverse.add(node[prop]);
        if (Utils.isObjectOrArray(next)) this.#nullFill(node[prop], next);
      }
      return;
    }

    const existing = node[prop];
    // Leaves and nulls are complete records; wholesale arrays too (their
    // element count is exact — extending them would corrupt the pre-state)
    if (existing === null || !Utils.isObjectOrArray(existing) || Array.isArray(existing)) {
      return;
    }
    // A complete clone needs no gap-fill (and `prev` here is already a
    // post-change value, not the pre-batch one); a partial fragment is
    // backfilled from the live container it stands for
    if (!this.#completeInverse.has(existing) && !prevMissing && Utils.isObjectOrArray(prev)) {
      if (this.#hasOps(existing, prev)) {
        // An array the batch spliced: its fragment speaks in pre-batch
        // positions, the live array in current ones, so it cannot be
        // backfilled; its pre-batch value is recorded whole instead
        node[prop] = this.#preBatchValue(prev, existing);
        if (Utils.isObjectOrArray(next)) this.#nullFill(node[prop], next);
        return;
      }
      this.#gapFill(existing, prev);
      // A container is only recorded at its own key when it is deleted or
      // replaced wholesale, so the backfilled fragment now describes the
      // entire pre-batch container: complete, like a clone
      this.#completeInverse.add(existing);
    }
    if (Utils.isObjectOrArray(next)) {
      this.#nullFill(existing, next);
    }
  }

  /**
   * Walk to (creating as needed) the inverse node for a path. Returns null
   * when an ancestor is already recorded as a leaf, null, or wholesale
   * array — changes below it are covered by restoring it. A complete
   * object clone on the way is descended (its nested plain objects are
   * complete too) with `complete` set, so the caller records only what a
   * merge-applied clone cannot undo on its own. Array nodes are stamped
   * with their pre-batch `$length` like forward nodes, so an inverse
   * fragment stays self-describing.
   * @param {Array} livePath - Where the node's value is now, for the
   *   live lookups
   * @param {Array} [path] - Where it was when the batch began, which is
   *   where the inverse records it (see recordInverse)
   * @returns {{ node: Object, complete: boolean, live: * } | null} —
   *   `live` is the current value at `path`, for kind checks
   */
  #inverseNode(livePath, path = livePath) {
    let node = this.#masterInverse;
    let parent = null;
    let live = this.#root;
    let complete = false;
    this.#stampLength(node, live);
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      live = Utils.isObjectOrArray(live) ? live[livePath[i]] : undefined;
      parent = node;
      if (!(seg in node)) {
        // Below a complete clone every container the batch created was
        // recorded as null at its own key, so a missing segment cannot
        // occur; created nodes elsewhere are stamped as in getDiffObject
        if (complete) return null;
        node = node[seg] = {};
        this.#stampLength(node, live);
        continue;
      }
      const next = node[seg];
      if (!Utils.isObjectOrArray(next) || Array.isArray(next)) return null;
      if (this.#completeInverse.has(next)) complete = true;
      node = next;
    }
    return { node, complete, live, parent, key: path[path.length - 1] };
  }

  /**
   * Backfill keys of `prev` (the live pre-deletion/replacement container)
   * that the fragment hasn't recorded yet. Existing entries win — they hold
   * older (pre-batch) values.
   */
  #gapFill(fragment, prev) {
    // An array fragment is applied by merge too: a hole must be a
    // deletion, or undo leaves whatever the batch put there
    if (Array.isArray(prev)) {
      for (let i = 0; i < prev.length; i++) {
        if (!(i in prev) && !(i in fragment)) fragment[i] = null;
      }
    }
    for (const key of Object.keys(prev)) {
      if (Utils.isUnsafeKey(key)) continue;
      if (!(key in fragment)) {
        fragment[key] = Utils.isObjectOrArray(prev[key])
          ? Utils.deepClone(prev[key])
          : prev[key];
      } else if (this.#hasOps(fragment[key], prev[key])) {
        // A spliced array cannot be backfilled (see recordInverse)
        fragment[key] = this.#preBatchValue(prev[key], fragment[key]);
      } else if (Utils.isObjectOrArray(fragment[key]) && !Array.isArray(fragment[key]) &&
        !this.#completeInverse.has(fragment[key]) && Utils.isObjectOrArray(prev[key]) &&
        Utils.hasArrayMarker(fragment[key]) === Array.isArray(prev[key])) {
        // Backfill partial fragments only. A complete clone needs nothing,
        // and the live value below it may already be of another kind
        // (the batch replaced the object it records with an array);
        // likewise a partial fragment is only backfilled from a live
        // container of the kind it describes
        this.#gapFill(fragment[key], prev[key]);
      }
    }
  }

  /**
   * A complete array record (every index recorded, holes as null) as the
   * real array it describes. Its element records are complete too, and
   * receivers apply them as the full values a real array holds, so an
   * element's array record (a backfilled fragment) becomes its array as
   * well: kept as a fragment, it would read as an object with index keys
   */
  #asArray(fragment) {
    const out = [];
    out.length = typeof fragment.$length === 'number' ? fragment.$length : 0;
    for (const key of Object.keys(fragment)) {
      if (INDEX_RE.test(key) && Number(key) < out.length && fragment[key] !== null) {
        out[key] = Utils.reviveArrayDiffs(fragment[key]);
      }
    }
    return out;
  }

  /**
   * Whether an inverse fragment for the live array `live` carries `$splice`
   * ops (itself, not below it)
   */
  #hasOps(fragment, live) {
    return Array.isArray(live) && Utils.isObjectOrArray(fragment) && !Array.isArray(fragment) &&
      !this.#completeInverse.has(fragment) && Array.isArray(fragment.$splice);
  }

  /**
   * The value `live` had when the batch began: its inverse fragment
   * applied to a copy of it. The fragment is exact for everything the
   * batch changed, and the rest is unchanged
   */
  #preBatchValue(live, fragment) {
    const value = Utils.deepClone(live);
    this.applyFragment(value, Utils.deepClone(fragment));
    return value;
  }

  /**
   * Applies a fragment to a plain container with receiver patch semantics
   * (set by LazyWatch)
   */
  applyFragment = () => {
    throw new Error('DiffTracker.applyFragment was not set');
  };

  /**
   * Record null (= delete on undo) for keys the new value introduces that
   * the fragment doesn't cover. For array fragments only shared indices
   * recurse — the fragment's element count is exact, and its `length` entry
   * truncates anything the new value added beyond it.
   */
  #nullFill(fragment, next) {
    // A kind change (object replaced by an array or vice versa) is undone
    // by wholesale replacement — receivers replace across kinds — so the
    // new value's keys need no null markers; they would only corrupt the
    // fragment (an array fragment gaining object keys can no longer be
    // revived into an array)
    const describesArray = Array.isArray(fragment) || Utils.hasArrayMarker(fragment);
    if (describesArray !== Array.isArray(next)) return;
    if (Array.isArray(fragment)) {
      const n = Math.min(fragment.length, next.length);
      for (let i = 0; i < n; i++) {
        if (Utils.isObjectOrArray(fragment[i]) && Utils.isObjectOrArray(next[i])) {
          this.#nullFill(fragment[i], next[i]);
        }
      }
      return;
    }
    for (const key of Object.keys(next)) {
      if (Utils.isUnsafeKey(key)) continue;
      if (!(key in fragment)) {
        fragment[key] = null;
      } else if (Utils.isObjectOrArray(fragment[key]) && Utils.isObjectOrArray(next[key])) {
        this.#nullFill(fragment[key], next[key]);
      }
    }
  }

  /**
   * Record a splice on the array at `path` as one `$splice` op. Keys the
   * node already holds move with their elements (see spliceIndexKeys), and
   * so do containers destroyed below it this batch, so every structural
   * change to an array is an op, whatever the batch wrote before it. A
   * node that is the diff's own copy of an array assigned whole this batch
   * is a full value: the copy takes the splice itself.
   * @param {Array} items - The inserted values, as the diff's own copies
   * @param {number} newLength - The array's length after the op
   */
  recordSplice(path, start, deleteCount, items, newLength, live) {
    const node = this.getDiffObject(path);
    if (Array.isArray(node)) {
      node.splice(start, deleteCount, ...items);
      return;
    }
    // Receivers apply ops before keys, so elements the batch wrote past
    // the end receivers know (a push) are not there yet when this op is:
    // they go in as an op of their own first. A truncation needs nothing:
    // the elements receivers still hold beyond it trail every op, and the
    // node's \`$length\` cuts them off last
    let received = this.#received?.get(node) ?? this.#baseLength?.get(node) ?? live.length;
    if (live.length > received) {
      const grown = [];
      for (let i = received; i < live.length; i++) {
        grown.push(!(i in live) ? null : Utils.isObjectOrArray(live[i]) ? Utils.deepClone(live[i]) : live[i]);
      }
      for (const key of Object.keys(node)) {
        if (INDEX_RE.test(key) && Number(key) >= received) delete node[key];
      }
      (node.$splice ??= []).push([received, 0, grown]);
      // A hole goes in as null and is deleted again
      for (let i = received; i < live.length; i++) {
        if (!(i in live)) node[i] = null;
      }
      received = live.length;
    }
    (this.#received ??= new WeakMap()).set(node, received - deleteCount + items.length);
    // What the batch changed in an element the op takes out goes with it
    // in the op's items (receivers never see those changes as changes);
    // kept aside, per object, for a listener following it back in
    for (let i = start; i < start + deleteCount; i++) {
      if (node[i] !== undefined && Utils.isObjectOrArray(live[i])) this.#carry(live[i], node[i]);
    }
    spliceIndexKeys(node, start, deleteCount, items.length);
    this.#spliceLosses(path, start, deleteCount, items.length);
    (node.$splice ??= []).push([start, deleteCount, items]);
    // Re-insert the stamp so the fragment serializes as { $splice, $length }
    delete node.$length;
    node.$length = newLength;
  }

  /**
   * Record the op that undoes a splice about to run on `live` (the array
   * at `path`): ops are applied before keys, and the inverse's ops in the
   * reverse order of the batch's, so each new one goes first. What the op
   * removes comes back as it is now; keys recorded under it restore
   * whatever the batch changed in it before. A hole comes back as null
   * and is deleted again by a key, like any hole the batch filled.
   */
  recordInverseSplice(path, live, start, deleteCount, inserted) {
    if (!this.inverseEnabled) return;
    const before = preBatchPath(this.#masterDiff, path);
    if (before === null) return; // the array is new this batch
    const found = this.#inverseNode(path, before);
    if (found === null) return;
    if (found.complete) {
      // Undo merges a complete record in index by index, which assumes
      // each index still holds the element it describes; an op moves them.
      // The array's pre-batch value goes in whole instead: a real array is
      // applied by replacement, whatever the batch did to it. (A record of
      // an object means the array itself is new: undo replaces it.)
      if (found.parent !== null && Utils.hasArrayMarker(found.node)) {
        found.parent[found.key] = this.#asArray(found.node);
      }
      return;
    }
    const removed = [];
    for (let i = start; i < start + deleteCount; i++) {
      removed.push(!(i in live) ? null : Utils.isObjectOrArray(live[i]) ? Utils.deepClone(live[i]) : live[i]);
    }
    (found.node.$splice ??= []).unshift([start, inserted, removed]);
    for (let i = start; i < start + deleteCount; i++) {
      if (!(i in live)) this.recordInverse(path, String(i), undefined);
    }
  }

  /**
   * Record, before a truncation of `live` (the array at `path`) to
   * `newLength`, what undo needs when the batch spliced the array before:
   * its ops each expect the array as they left it, so the removed tail
   * goes back in first, as an op of its own (a hole as null, deleted
   * again by a key). Without earlier ops the truncated elements' keys
   * restore them, as always
   */
  recordInverseTruncation(path, live, newLength) {
    const node = this.#inverseOps(path);
    if (node === null) return;
    const tail = [];
    for (let i = newLength; i < live.length; i++) {
      tail.push(!(i in live) ? null : Utils.isObjectOrArray(live[i]) ? Utils.deepClone(live[i]) : live[i]);
    }
    node.$splice.unshift([newLength, 0, tail]);
    for (let i = newLength; i < live.length; i++) {
      if (!(i in live)) this.recordInverse(path, String(i), undefined);
    }
  }

  /**
   * Record, before `live` (the array at `path`) grows to `newLength`, the
   * op removing what grows when the batch spliced the array before: undo
   * applies its ops first, each expecting the array as it left it, and
   * the grown elements must be gone before an earlier truncation's op
   * puts the tail back where they are. Without earlier ops, keys and the
   * pre-batch \`$length\` remove them, as always
   */
  recordInverseGrowth(path, live, newLength) {
    if (newLength <= live.length) return;
    this.#inverseOps(path)?.$splice.unshift([live.length, newLength - live.length, []]);
  }

  /**
   * The inverse node of the array at `path` when the batch has recorded
   * ops for it (see recordInverseSplice), else null
   */
  #inverseOps(path) {
    if (!this.inverseEnabled) return null;
    const before = preBatchPath(this.#masterDiff, path);
    if (before === null) return null;
    const found = this.#inverseNode(path, before);
    if (found === null || found.complete || !Array.isArray(found.node.$splice)) return null;
    return found.node;
  }

  /**
   * Containers destroyed below an array this batch are remembered by
   * position (see recordContainerLoss); a splice moves those positions
   * like it moves the diff node's keys, and forgets the ones it removes
   */
  #spliceLosses(path, start, deleteCount, inserted) {
    if (this.#lostContainers.size === 0) return;
    const depth = path.length;
    const moved = [];
    for (const [key, entry] of this.#lostContainers) {
      const full = JSON.parse(key);
      if (full.length <= depth || !INDEX_RE.test(full[depth])) continue;
      if (path.some((seg, i) => String(seg) !== String(full[i]))) continue;
      const index = Number(full[depth]);
      if (index < start) continue;
      this.#lostContainers.delete(key);
      if (index < start + deleteCount) continue;
      full[depth] = String(index + inserted - deleteCount);
      moved.push([JSON.stringify(full), entry]);
    }
    for (const [key, entry] of moved) {
      if (!this.#lostContainers.has(key)) this.#lostContainers.set(key, entry);
    }
  }

  /**
   * A destroyed container is kept as it was destroyed, by reference; an
   * object put back into the tree (a handle's object reinserted) could
   * then change under that record. Called before one is: the records
   * take copies
   */
  freezeLosses() {
    for (const entry of this.#lostContainers.values()) {
      if (entry.frozen) continue;
      entry.container = Utils.deepClone(entry.container);
      entry.frozen = true;
    }
  }

  /**
   * The diff node at `path` if one exists, without creating it
   */
  peekDiffObject(path) {
    let node = this.#masterDiff;
    for (let i = 0; i < path.length; i++) {
      if (!Utils.isObjectOrArray(node)) return undefined;
      node = node[path[i]];
    }
    return Utils.isObjectOrArray(node) ? node : undefined;
  }

  /**
   * Record a container destroyed at path+prop this batch (first loss
   * wins), together with the diff node recorded for it so far: keys the
   * batch already deleted from the container are gone from the live
   * object but still held by receivers, and only the node's null markers
   * remember them once the node is replaced.
   * @param {Object} [node] - The container's diff node at loss time
   */
  recordContainerLoss(path, prop, container, node) {
    const key = JSON.stringify([...path, prop]);
    if (!this.#lostContainers.has(key)) {
      this.#lostContainers.set(key, { container, node, order: this.#lostContainers.size });
    }
    // Its changes leave with it, as with an element an op takes out: a
    // handle's object can be put back by a write
    if (node !== undefined) this.#carry(container, node);
  }

  /** Keep a fragment of what the batch changed in `object` as it left the tree (see #carried) */
  #carry(object, fragment) {
    this.#carried ??= new Map();
    const trail = this.#carried.get(object);
    if (trail) trail.push(fragment);
    else this.#carried.set(object, [fragment]);
  }

  /**
   * What receivers still hold at path+prop when it was destroyed earlier
   * this batch, as `{ container, node }`, or undefined. Receivers are at
   * the pre-batch state, so the earliest loss on the way down wins: when
   * an ancestor was lost first, its recorded container and diff node are
   * walked down to the slot (an ancestor lost later than the slot itself
   * changes nothing about what receivers hold there). The size guard
   * keeps the common case (no destruction this batch) free of the
   * path-key allocations on the write path.
   */
  getContainerLoss(path, prop) {
    if (this.#lostContainers.size === 0) return undefined;
    const full = [...path, prop];
    let best = null;
    let bestDepth = 0;
    for (let depth = full.length; depth >= 1; depth--) {
      const entry = this.#lostContainers.get(JSON.stringify(full.slice(0, depth)));
      if (entry && (best === null || entry.order < best.order)) {
        best = entry;
        bestDepth = depth;
      }
    }
    if (best === null) return undefined;
    let { container, node } = best;
    for (let i = bestDepth; i < full.length; i++) {
      container = Utils.isObjectOrArray(container) ? container[full[i]] : undefined;
      node = Utils.isObjectOrArray(node) ? node[full[i]] : undefined;
    }
    if (!Utils.isObjectOrArray(container) && !Utils.isObjectOrArray(node)) return undefined;
    return { container, node };
  }

  /**
   * Get the current master diff and reset it.
   *
   * The diff shares no references with live state — every container it
   * records is its own copy (see ProxyHandler.#staleFilledDiffValue) — so
   * it is handed out as-is; nothing writes into it after this point.
   */
  consumeDiff() {
    const diff = this.#masterDiff;
    this.#masterDiff = {};
    // Batch boundary: receivers are caught up once this diff is applied
    this.#lostContainers.clear();
    this.#consumedCarried = this.#carried;
    this.#carried = null;
    return diff;
  }

  /**
   * The fragments objects carried out of the tree in the batch consumed
   * last, per object (see #carried); handed out once
   */
  takeCarried() {
    const carried = this.#consumedCarried ?? NOTHING_CARRIED;
    this.#consumedCarried = null;
    return carried;
  }

  /**
   * Get the current inverse diff and reset it. Must be consumed in lockstep
   * with consumeDiff() so the pair always describes the same batch.
   */
  consumeInverse() {
    const inverse = this.#masterInverse;
    this.#masterInverse = {};
    this.#completeInverse = new WeakSet();
    return inverse;
  }

  /**
   * Check if there are any pending changes
   */
  hasPendingChanges() {
    return Object.keys(this.#masterDiff).length > 0;
  }

  /**
   * Get a copy of the current pending diff without consuming it
   * Returns a deep clone to prevent external modifications
   */
  getPendingDiff() {
    // Return a deep clone to prevent external modifications
    return Utils.deepClone(this.#masterDiff);
  }

  /**
   * Clear all pending diffs
   */
  clear() {
    this.#masterDiff = {};
    this.#masterInverse = {};
    this.#completeInverse = new WeakSet();
    this.#lostContainers.clear();
    this.#carried = null;
    this.#consumedCarried = null;
  }
}
