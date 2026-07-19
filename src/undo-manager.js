// undo-manager.js - Undo/redo stacks built on inverse diffs

/**
 * UndoManager - records each emitted batch as an undoable step
 *
 * Created via LazyWatch.createUndoManager(watched, options), which wires it
 * to the instance's emitter and enables inverse recording for the manager's
 * lifetime. The manager listens for batches, pushing { diff, inverse } pairs
 * onto an undo stack; undo() applies the inverse, redo() re-applies the
 * forward diff. Both apply through the instance's normal patch path and
 * flush synchronously, so other listeners (mirrors, renderers) observe the
 * undo/redo as an ordinary batch — while the manager's own listener is
 * guarded so the application is not recorded as a new step.
 *
 * Dependencies are injected as closures so the class stays decoupled from
 * LazyWatch internals.
 */
export class UndoManager {
  #undoStack = [];
  #redoStack = [];
  #limit;
  #applying = false;
  #disposed = false;
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
   * @param {Function} [deps.onDispose] - Called once when disposed
   * @param {number} [deps.limit=Infinity] - Maximum undo depth; the oldest
   *   step is dropped when exceeded
   */
  constructor({ subscribe, flush, patch, hasPending, onDispose, limit = Infinity }) {
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) {
      throw new TypeError('UndoManager limit must be a positive integer or Infinity');
    }
    this.#limit = limit;
    this.#flush = flush;
    this.#patch = patch;
    this.#hasPending = hasPending;
    this.#onDispose = onDispose;
    this.#unsubscribe = subscribe((diff, inverse) => this.#record(diff, inverse));
  }

  /**
   * Record an emitted batch as an undoable step. Batches produced by
   * undo()/redo() themselves are guarded out; any other batch is a new
   * change and therefore invalidates the redo stack.
   */
  #record(diff, inverse) {
    if (this.#applying) return;
    this.#undoStack.push({ diff, inverse });
    if (this.#undoStack.length > this.#limit) this.#undoStack.shift();
    this.#redoStack.length = 0;
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
   * form the step being undone rather than mixing into an older one.
   * @returns {boolean} True if a step was undone, false when there was
   *   nothing to undo (or the manager is disposed)
   */
  undo() {
    if (this.#disposed) return false;
    this.#flush();
    const entry = this.#undoStack.pop();
    if (!entry) return false;
    this.#apply(entry.inverse);
    this.#redoStack.push(entry);
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
    const entry = this.#redoStack.pop();
    if (!entry) return false;
    this.#apply(entry.diff);
    this.#undoStack.push(entry);
    return true;
  }

  /**
   * Apply a diff with the recording guard set, flushing synchronously so
   * the resulting batch reaches (and is ignored by) the manager's own
   * listener while the guard is still up. Other listeners receive it as a
   * normal batch.
   */
  #apply(diff) {
    this.#applying = true;
    try {
      this.#patch(diff);
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
  }

  /**
   * Detach from the instance: stop recording, drop history, and restore
   * the instance's inverse-recording setting. Idempotent. After disposal,
   * undo()/redo() return false and canUndo/canRedo are false.
   */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.clear();
    if (this.#onDispose) this.#onDispose();
  }
}
