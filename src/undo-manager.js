// undo-manager.js - Undo/redo stacks built on inverse diffs

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
 * Dependencies are injected as closures so the class stays decoupled from
 * LazyWatch internals.
 */
export class UndoManager {
  #undoStack = [];
  #redoStack = [];
  #limit;
  #coalesce;
  #compose;
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
   * @param {Function} deps.flush - Synchronously emit pending changes
   * @param {Function} deps.patch - Apply a diff to the watched state
   * @param {Function} deps.hasPending - True when un-emitted changes exist
   * @param {Function} deps.compose - (older, newer) => single equivalent
   *   diff; throws when the pair has no single-diff representation
   * @param {Function} [deps.onDispose] - Called once when disposed
   * @param {number} [deps.limit=Infinity] - Maximum undo depth; the oldest
   *   step is dropped when exceeded
   * @param {number} [deps.coalesce=0] - Milliseconds: batches arriving
   *   within this window of the previous one merge into the same step
   *   (0 disables). The window slides with activity
   */
  constructor({ subscribe, flush, patch, hasPending, compose, onDispose,
                limit = Infinity, coalesce = 0 }) {
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
    this.#unsubscribe = subscribe((diff, inverse) => this.#record(diff, inverse));
  }

  /**
   * Record an emitted batch. Batches produced by undo()/redo() themselves
   * are guarded out; any other batch is a new change and therefore
   * invalidates the redo stack. Inside group() — or within the coalesce
   * window — the batch merges into the open step instead of starting one.
   */
  #record(diff, inverse) {
    if (this.#applying) return;
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
      this.#flush();
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
