// diff-tracker.js - Handles diff tracking
import {Utils} from "./utils.js";

export class DiffTracker {
  #masterDiff = {};
  #masterInverse = {};
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

  constructor() {}

  /**
   * Get or create a nested diff object at the given path
   */
  getDiffObject(path = []) {
    let diffObj = this.#masterDiff;
    for (let i = 0; i < path.length; i++) {
      if (!diffObj[path[i]]) {
        diffObj[path[i]] = {};
      }
      diffObj = diffObj[path[i]];
    }
    return diffObj;
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
    const node = this.#inverseNode(path);
    if (node === null) return; // covered by a recorded ancestor value

    const prevMissing = prev === undefined;
    if (!(prop in node)) {
      node[prop] = prevMissing
        ? null
        : (Utils.isObjectOrArray(prev) ? Utils.deepClone(prev) : prev);
      if (!prevMissing && Utils.isObjectOrArray(node[prop]) && Utils.isObjectOrArray(next)) {
        this.#nullFill(node[prop], next);
      }
      return;
    }

    const existing = node[prop];
    // Leaves and nulls are complete records; wholesale arrays too (their
    // element count is exact — extending them would corrupt the pre-state)
    if (existing === null || !Utils.isObjectOrArray(existing) || Array.isArray(existing)) {
      return;
    }
    if (!prevMissing && Utils.isObjectOrArray(prev)) {
      this.#gapFill(existing, prev);
    }
    if (Utils.isObjectOrArray(next)) {
      this.#nullFill(existing, next);
    }
  }

  /**
   * Walk to (creating as needed) the inverse node for a path. Returns null
   * when an ancestor is already recorded as a complete value (leaf, null,
   * or wholesale array) — changes below it are covered by restoring it.
   */
  #inverseNode(path) {
    let cur = this.#masterInverse;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      if (!(seg in cur)) {
        cur = cur[seg] = {};
        continue;
      }
      const next = cur[seg];
      if (!Utils.isObjectOrArray(next) || Array.isArray(next)) return null;
      cur = next;
    }
    return cur;
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
        Utils.isObjectOrArray(prev[key])) {
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
    if (Array.isArray(fragment)) {
      if (!Array.isArray(next)) return;
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
   * Record a container destroyed at path+prop this batch (first loss wins)
   */
  recordContainerLoss(path, prop, container) {
    const key = JSON.stringify([...path, prop]);
    if (!this.#lostContainers.has(key)) {
      this.#lostContainers.set(key, container);
    }
  }

  /**
   * The container destroyed at path+prop earlier this batch, if any.
   * The size guard keeps the common case (no destruction this batch) free
   * of the path-key allocation on the write path.
   */
  getContainerLoss(path, prop) {
    if (this.#lostContainers.size === 0) return undefined;
    return this.#lostContainers.get(JSON.stringify([...path, prop]));
  }

  /**
   * Get the current master diff and reset it.
   *
   * Returns a deep clone: during a batch, wholesale container assignments
   * alias diff nodes to the live target subtrees, so handing out the raw
   * diff would let later mutations retroactively rewrite a diff a consumer
   * kept (send buffers, undo stacks, ...).
   */
  consumeDiff() {
    const diff = this.#masterDiff;
    this.#masterDiff = {};
    // Batch boundary: receivers are caught up once this diff is applied
    this.#lostContainers.clear();
    return Utils.deepClone(diff);
  }

  /**
   * Get the current inverse diff and reset it. Must be consumed in lockstep
   * with consumeDiff() so the pair always describes the same batch.
   */
  consumeInverse() {
    const inverse = this.#masterInverse;
    this.#masterInverse = {};
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
    // (structured clone, not JSON, so Date leaves survive intact)
    return Utils.deepClone(this.#masterDiff);
  }

  /**
   * Clear all pending diffs
   */
  clear() {
    this.#masterDiff = {};
    this.#masterInverse = {};
    this.#lostContainers.clear();
  }
}
