// diff-tracker.js - Handles diff tracking
import {Utils} from "./utils.js";

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
  // detached containers themselves — nothing mutates them after detachment
  // (re-insertion always clones).
  #lostContainers = new Map();

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
    const found = this.#inverseNode(path);
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
   * @returns {{ node: Object, complete: boolean, live: * } | null} —
   *   `live` is the current value at `path`, for kind checks
   */
  #inverseNode(path) {
    let node = this.#masterInverse;
    let live = this.#root;
    let complete = false;
    this.#stampLength(node, live);
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      live = Utils.isObjectOrArray(live) ? live[seg] : undefined;
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
    return { node, complete, live };
  }

  /**
   * Backfill keys of `prev` (the live pre-deletion/replacement container)
   * that the fragment hasn't recorded yet. Existing entries win — they hold
   * older (pre-batch) values.
   */
  #gapFill(fragment, prev) {
    for (const key of Object.keys(prev)) {
      if (Utils.isUnsafeKey(key)) continue;
      if (!(key in fragment)) {
        fragment[key] = Utils.isObjectOrArray(prev[key])
          ? Utils.deepClone(prev[key])
          : prev[key];
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
    return diff;
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
  }
}
