// undo-manager.js - Undo/redo stacks built on inverse diffs
import { Utils } from './utils.js';

/**
 * UndoManager - records emitted batches as undoable steps
 *
 * Created via LazyWatch.createUndoManager(watched, options), which wires it
 * to the instance's emitter and enables inverse recording for the manager's
 * lifetime. The manager listens for batches and pushes steps onto an undo
 * stack; undo() applies a step's inverses, redo() its forward diffs. Both
 * apply through the instance's normal patch path and flush synchronously,
 * so other listeners (mirrors, renderers) observe the whole step as one
 * ordinary batch — while the manager's own listener is guarded so the
 * application is not recorded as a new step.
 *
 * A step is a non-empty array of { diff, inverse } segments. A plain batch
 * is a single-segment step. group() and the `coalesce` window merge
 * consecutive batches into one step: each incoming batch is composed into
 * the step's last segment when the diff algebra allows (composeDiffs), and
 * appended as a new segment when the pair has no single-diff
 * representation — applying segments sequentially is always valid, so
 * merging never loses correctness, only compactness.
 *
 * A `record` predicate can exclude batches that are not the user's own
 * edits (a sync layer's remote diffs, tagged through batch metadata). Such
 * a batch is not a step, but it still changes the state the recorded steps
 * describe: where it changed the shape of the tree — an array's length, a
 * container created, deleted, or changed in kind — every step touching that
 * path is dropped (see #invalidate), so history never truncates or replaces
 * what the foreign batch put there. Field-level foreign writes leave
 * history alone: last-writer-wins, as documented for inverse diffs.
 *
 * Dependencies are injected as closures so the class stays decoupled from
 * LazyWatch internals; only the pure wire-format helpers in utils.js are
 * imported.
 */
export class UndoManager {
  #undoStack = [];
  #redoStack = [];
  #limit;
  #coalesce;
  #compose;
  #shouldRecord;
  #applying = false;
  #grouping = false;
  #disposed = false;
  // The step still accepting merges — the current group, or the last
  // recorded step while the coalesce window is open — and the time of its
  // last merge (the window slides with activity, debounce-style)
  #openStep = null;
  #openStepTime = 0;
  #unsubscribe;
  #flush;
  #patch;
  #hasPending;
  #onDispose;

  /**
   * @param {Object} deps
   * @param {Function} deps.subscribe - (listener) => unsubscribe; listener
   *   receives (diff, inverse) per batch
   * @param {Function} deps.flush - (meta?) => void; synchronously emit
   *   pending changes, tagged with `meta` when given
   * @param {Function} deps.patch - Apply a diff to the watched state
   * @param {Function} deps.hasPending - True when un-emitted changes exist
   * @param {Function} deps.compose - (older, newer) => single equivalent
   *   diff; throws when the pair has no single-diff representation
   * @param {Function} [deps.onDispose] - Called once when disposed
   * @param {Function} [deps.record] - (meta, diff) => boolean; a batch for
   *   which it returns false is not recorded as a step but invalidates the
   *   steps it conflicts with (see #invalidate). Default: record every batch
   * @param {number} [deps.limit=Infinity] - Maximum undo depth; the oldest
   *   step is dropped when exceeded
   * @param {number} [deps.coalesce=0] - Milliseconds: batches arriving
   *   within this window of the previous one merge into the same step
   *   (0 disables). The window slides with activity
   */
  constructor({ subscribe, flush, patch, hasPending, compose, onDispose,
                record = null, limit = Infinity, coalesce = 0 }) {
    if (record !== null && typeof record !== 'function') {
      throw new TypeError('UndoManager record must be a function (meta, diff) => boolean');
    }
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) {
      throw new TypeError('UndoManager limit must be a positive integer or Infinity');
    }
    if (typeof coalesce !== 'number' || !Number.isFinite(coalesce) || coalesce < 0) {
      throw new TypeError('UndoManager coalesce must be a non-negative number of milliseconds');
    }
    this.#limit = limit;
    this.#coalesce = coalesce;
    this.#compose = compose;
    this.#flush = flush;
    this.#patch = patch;
    this.#hasPending = hasPending;
    this.#onDispose = onDispose;
    this.#shouldRecord = record;
    this.#unsubscribe = subscribe((diff, inverse, meta) => this.#onBatch(diff, inverse, meta));
  }

  /**
   * Handle an emitted batch. Batches produced by undo()/redo() themselves
   * are guarded out; a batch the `record` predicate declines is not a
   * step but may invalidate existing ones; any other batch is a new change
   * and therefore invalidates the redo stack. Inside group() — or within
   * the coalesce window — the batch merges into the open step instead of
   * starting one.
   */
  #onBatch(diff, inverse, meta) {
    if (this.#applying) return;
    if (this.#shouldRecord !== null && !this.#shouldRecord(meta, diff)) {
      this.#invalidate(diff, inverse);
      return;
    }
    const now = Date.now();
    const mergeable = this.#openStep !== null &&
      (this.#grouping ||
        (this.#coalesce > 0 && now - this.#openStepTime <= this.#coalesce));
    if (mergeable) {
      this.#mergeIntoStep(this.#openStep, diff, inverse);
    } else {
      const step = [{ diff, inverse }];
      this.#undoStack.push(step);
      if (this.#undoStack.length > this.#limit) this.#undoStack.shift();
      this.#openStep = step;
    }
    this.#openStepTime = now;
    this.#redoStack.length = 0;
  }

  /**
   * Merge a batch into an existing step: composed into its last segment
   * when both the forward pair and the inverse pair are representable as
   * single diffs, appended as a new segment otherwise. Undoing the merged
   * pair applies the newer inverse first, hence the argument order.
   */
  #mergeIntoStep(step, diff, inverse) {
    const last = step[step.length - 1];
    try {
      const composedDiff = this.#compose(last.diff, diff);
      const composedInverse = this.#compose(inverse, last.inverse);
      last.diff = composedDiff;
      last.inverse = composedInverse;
    } catch (e) {
      step.push({ diff, inverse });
    }
  }

  /**
   * Reconcile history with a batch that was not recorded. Its forward diff
   * and inverse describe the same paths after and before the batch, so
   * comparing them finds where the shape of the tree changed; every step
   * with a node at such a path, or a complete value over it, is dropped
   * from both stacks. A recorded step's array nodes carry the length they
   * saw, so applying one across a foreign length change would truncate or
   * regrow the array around the foreign elements; its object fragments
   * would merge into a container that has since changed kind or been
   * recreated. The surviving steps never touch the changed paths, so they
   * remain sequentially consistent with each other.
   */
  #invalidate(diff, inverse) {
    const changed = [];
    collectShapeChanges(diff, inverse, [], changed);
    if (changed.length === 0) return;
    const conflicts = step => step.some(segment =>
      changed.some(path => touches(segment.diff, path) || touches(segment.inverse, path)));
    this.#undoStack = this.#undoStack.filter(step => !conflicts(step));
    this.#redoStack = this.#redoStack.filter(step => !conflicts(step));
    if (this.#openStep !== null && !this.#undoStack.includes(this.#openStep)) this.#openStep = null;
  }

  /**
   * Execute a callback and record every batch it emits as ONE undo step.
   *
   * Pending changes from before the group are flushed first (forming
   * their own step), and trailing changes still pending when the callback
   * returns are flushed into the group. The callback must be synchronous;
   * groups cannot be nested. Not a transaction: if the callback throws,
   * its already-applied changes stay applied (recorded as one step) and
   * the error is rethrown — wrap the callback body in
   * LazyWatch.transaction for atomicity.
   *
   * @param {Function} callback - Function whose batches form one step
   * @returns {*} The callback's return value
   */
  group(callback) {
    if (this.#disposed) throw new Error('UndoManager has been disposed');
    if (this.#grouping) throw new Error('UndoManager.group cannot be nested');
    // Changes from before the group must not join its step
    this.#flush();
    this.#grouping = true;
    this.#openStep = null;
    try {
      return callback();
    } finally {
      // Trailing changes still pending join the group before it closes
      this.#flush();
      this.#grouping = false;
      this.#openStep = null;
    }
  }

  /**
   * End the current coalescing window: the next recorded batch starts a
   * new undo step. Useful as an "undo stop" on blur/enter/selection
   * change. A no-op inside group() (a group is always exactly one step).
   */
  checkpoint() {
    if (!this.#grouping) this.#openStep = null;
  }

  /**
   * True when there is a step to undo. Pending (not yet emitted) changes
   * count: undo() flushes them into a step first, so with throttle/debounce
   * a just-made change is undoable before its timer fires.
   * @returns {boolean}
   */
  get canUndo() {
    return !this.#disposed && (this.#undoStack.length > 0 || this.#hasPending());
  }

  /**
   * True when there is an undone step to re-apply
   * @returns {boolean}
   */
  get canRedo() {
    return !this.#disposed && this.#redoStack.length > 0;
  }

  /**
   * Undo the most recent step. Pending changes are flushed first so they
   * form (or join) the step being undone rather than mixing into an older
   * one.
   * @returns {boolean} True if a step was undone, false when there was
   *   nothing to undo (or the manager is disposed)
   */
  undo() {
    if (this.#disposed) return false;
    this.#flush();
    this.#openStep = null;
    const step = this.#undoStack.pop();
    if (!step) return false;
    this.#applyStep(step, true);
    this.#redoStack.push(step);
    return true;
  }

  /**
   * Re-apply the most recently undone step. Pending changes are flushed
   * first; being new changes, they clear the redo stack, so redo() after
   * an intervening edit returns false (standard undo-history semantics).
   * @returns {boolean} True if a step was re-applied, false otherwise
   */
  redo() {
    if (this.#disposed) return false;
    this.#flush();
    this.#openStep = null;
    const step = this.#redoStack.pop();
    if (!step) return false;
    this.#applyStep(step, false);
    this.#undoStack.push(step);
    return true;
  }

  /**
   * Apply a step with the recording guard set: undo applies segment
   * inverses newest-first, redo applies forward diffs oldest-first. All
   * segments apply before the single synchronous flush, so other
   * listeners receive the whole step as one ordinary batch.
   */
  #applyStep(step, isUndo) {
    this.#applying = true;
    try {
      if (isUndo) {
        for (let i = step.length - 1; i >= 0; i--) {
          this.#patch(step[i].inverse);
        }
      } else {
        for (const segment of step) {
          this.#patch(segment.diff);
        }
      }
      // Tagged so other listeners can tell history replay from an edit
      this.#flush({ origin: isUndo ? 'undo' : 'redo' });
    } finally {
      this.#applying = false;
    }
  }

  /**
   * Drop all undo and redo history without touching the watched state
   */
  clear() {
    this.#undoStack.length = 0;
    this.#redoStack.length = 0;
    this.#openStep = null;
  }

  /**
   * Detach from the instance: stop recording, drop history, and restore
   * the instance's inverse-recording setting. Idempotent. After disposal,
   * undo()/redo() return false, canUndo/canRedo are false, and group()
   * throws.
   */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.clear();
    if (this.#onDispose) this.#onDispose();
  }
}

/**
 * The kind a diff node describes: 'array' for a real array or a marked
 * fragment, 'object' for an unmarked plain object (a fragment or a full
 * value), 'leaf' for everything else (primitives, null for a deletion or
 * absence, undefined for a path the batch did not touch)
 */
function kindOf(node) {
  if (Array.isArray(node)) return 'array';
  if (!Utils.isPlainObject(node)) return 'leaf';
  return Utils.hasArrayMarker(node) ? 'array' : 'object';
}

/**
 * Collect the paths at which a batch changed the shape of the tree, by
 * walking its forward diff (`after`) and inverse (`before`) together: a
 * kind change between them (a container created, deleted, or swapped for
 * the other kind), a real array on either side (wholesale values appear
 * only where no array was), or a fragment whose `$length` differs. Nothing
 * below a changed path matters; same-kind containers recurse
 */
function collectShapeChanges(after, before, path, out) {
  const kind = kindOf(after);
  if (kind !== kindOf(before) || Array.isArray(after) || Array.isArray(before)) {
    out.push(path);
    return;
  }
  if (kind === 'leaf') return;
  if (kind === 'array' && (after.$length !== before.$length || '$splice' in after)) {
    out.push(path);
    return;
  }
  for (const key of new Set([...Object.keys(after), ...Object.keys(before)])) {
    if (Utils.isReservedDiffKey(key)) continue;
    collectShapeChanges(after[key], before[key], [...path, key], out);
  }
}

/**
 * Does a step's diff (or inverse) touch `path`: a node at the path itself,
 * or a complete value — a leaf, a deletion, a real array — at an ancestor,
 * which applying would write over the whole subtree
 */
function touches(node, path) {
  for (const key of path) {
    if (node === undefined) return false;
    if (kindOf(node) === 'leaf' || Array.isArray(node)) return true;
    node = node[key];
  }
  return node !== undefined;
}
