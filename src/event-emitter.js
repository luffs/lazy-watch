// event-emitter.js - Handles event emission with batching
import {Utils} from "./utils.js";

const INDEX_RE = /^\d+$/;

export class EventEmitter {
  #listeners = [];
  #diffTracker;
  #microtaskGeneration = 0;
  #timeoutId = null;
  #throttle;
  #debounce;
  // Custom scheduler (options.schedule): when set, emits are dispatched
  // inside a callback handed to it instead of a queued microtask — e.g.
  // cb => requestAnimationFrame(cb) emits at most once per frame
  #schedule = null;
  // Generation the currently live custom-scheduler slot was created for;
  // null when no slot is live. Prevents queueing one slot per change.
  #scheduledGeneration = null;
  #lastEmitTime = 0;
  #paused = false;
  // (path) => { found, value }: the live watched state, consulted by
  // #filterDiffByPath for the one diff shape that cannot say whether a
  // nested listener's slot survived. Injected by LazyWatch after the
  // handler exists.
  #resolveState = null;

  constructor(diffTracker, options = {}) {
    if (!diffTracker) {
      throw new TypeError('EventEmitter requires a DiffTracker instance');
    }
    if (options.schedule !== undefined && typeof options.schedule !== 'function') {
      throw new TypeError('LazyWatch schedule option must be a function, e.g. cb => requestAnimationFrame(cb)');
    }
    this.#diffTracker = diffTracker;
    this.#throttle = options.throttle || 0;
    this.#debounce = options.debounce || 0;
    this.#schedule = options.schedule || null;
  }

  /**
   * Provide access to the live watched state: (path) => { found, value }
   */
  setStateResolver(resolve) {
    this.#resolveState = resolve;
  }

  /**
   * Add a change listener
   * @param {Function} listener - The listener function
   * @param {Array} path - The path of the proxy this listener is registered on
   * @param {Object} [options] - Listener options
   * @param {boolean} [options.once=false] - Remove the listener after its first invocation
   * @param {AbortSignal} [options.signal] - Removes the listener when aborted
   * @returns {Function} An idempotent unsubscribe function that removes
   *   exactly this registration
   */
  on(listener, path = [], options = {}) {
    if (typeof listener !== 'function') {
      throw new TypeError('Listener must be a function');
    }
    const { once = false, signal } = options;
    // Match addEventListener semantics: an already-aborted signal never adds
    if (signal && signal.aborted) return () => {};

    const entry = { listener, path, once, removed: false, detach: null };
    if (signal) {
      // Remove only this registration: the same function may also be
      // registered on other paths (or on this one without the signal).
      // The abort handler is detached again when the registration ends
      // any other way, so a long-lived signal doesn't keep this emitter
      // (and the instance behind it) reachable
      const onAbort = () => this.#remove(entry);
      signal.addEventListener('abort', onAbort, { once: true });
      entry.detach = () => signal.removeEventListener('abort', onAbort);
    }
    this.#listeners.push(entry);
    return () => this.#remove(entry);
  }

  /**
   * End a registration: drop it from the list, detach its abort handler,
   * and flag it so an emit already iterating over a snapshot skips it
   */
  #remove(entry) {
    if (entry.removed) return;
    entry.removed = true;
    if (entry.detach) entry.detach();
    const index = this.#listeners.indexOf(entry);
    if (index !== -1) {
      this.#listeners.splice(index, 1);
    }
  }

  /**
   * Remove a change listener
   * @param {Function} listener - The listener to remove
   * @param {Array} [path] - Only remove the registration made at this path;
   *   when omitted, the first registration of the function is removed
   */
  off(listener, path) {
    const entry = this.#listeners.find(l =>
      l.listener === listener && (path === undefined || this.#samePath(l.path, path)));
    if (entry) this.#remove(entry);
  }

  #samePath(a, b) {
    return a.length === b.length && a.every((segment, i) => segment === b[i]);
  }

  /**
   * Schedule a diff emission.
   *
   * One live dispatch per batch: the first change schedules it — a
   * microtask, a custom-scheduler slot, or a throttle timer — and later
   * changes in the same batch ride along until it fires. Re-scheduling per
   * change used to queue a fresh microtask (a closure plus the host's
   * async-resource wrapper) or tear down and re-arm the throttle timer for
   * every write: ~300 bytes of garbage per write, most of the write path's
   * cost, and a microtask queue that grew with the burst. Dispatches
   * outlived by flush/pause/dispose fire as no-ops via the generation
   * check. Only a debounce timer is re-armed per change — that is what
   * debouncing means.
   */
  scheduleEmit() {
    if (this.#paused) return;

    if (this.#debounce > 0) {
      // Each new change resets the timer
      this.#clearPending();
      this.#timeoutId = setTimeout(() => this.#timerDue(), this.#debounce);
      return;
    }

    if (this.#throttle > 0) {
      // A pending timer already covers this batch
      if (this.#timeoutId !== null) return;
      const timeSinceLastEmit = performance.now() - this.#lastEmitTime;
      if (timeSinceLastEmit < this.#throttle) {
        this.#timeoutId = setTimeout(() => this.#timerDue(), this.#throttle - timeSinceLastEmit);
        return;
      }
      // The window has passed: emit now-ish, like an unthrottled change
    }

    this.#scheduleImmediate();
  }

  /**
   * A throttle or debounce timer fired: release the slot, then dispatch
   */
  #timerDue() {
    this.#timeoutId = null;
    this.#emitDue();
  }

  /**
   * Dispatch an emit that should happen "now-ish": through the custom
   * scheduler when one is set (aligning emission to its slots), otherwise
   * on the next microtask.
   */
  #scheduleImmediate() {
    if (this.#schedule) {
      this.#scheduleCustom();
    } else {
      this.#scheduleMicrotask();
    }
  }

  /**
   * Dispatch an emit whose throttle/debounce timer has expired. The timer
   * decides WHEN the emit becomes due; a custom scheduler then aligns the
   * actual emission to its slot (e.g. the next animation frame).
   */
  #emitDue() {
    if (this.#schedule) {
      this.#scheduleCustom();
    } else {
      this.#emit();
    }
  }

  /**
   * Schedule an emit through the custom scheduler, keeping at most one
   * live slot per generation. The slot callback re-validates the
   * generation before emitting, so slots outlived by a flush, pause, or
   * dispose fire as no-ops (custom schedulers have no cancel handle).
   */
  #scheduleCustom() {
    if (this.#scheduledGeneration === this.#microtaskGeneration) return;
    const generation = this.#microtaskGeneration;
    this.#scheduledGeneration = generation;
    this.#schedule(() => {
      // Clear only our own marker: a newer slot may already be live
      if (this.#scheduledGeneration === generation) {
        this.#scheduledGeneration = null;
      }
      if (this.#microtaskGeneration === generation) {
        this.#emit();
      }
    });
  }

  /**
   * Emit the current diff to all listeners
   */
  /**
   * @param {Object} [meta] - Batch metadata handed to every listener as
   *   the third argument (only synchronous emits carry one: flush, and
   *   patch/overwrite called with metadata)
   */
  #emit(meta) {
    if (!this.#diffTracker.hasPendingChanges()) return;

    this.#lastEmitTime = performance.now();

    const diff = this.#diffTracker.consumeDiff();
    // Consumed in lockstep with the forward diff so the pair always
    // describes the same batch
    const inverse = this.#diffTracker.inverseEnabled
      ? this.#diffTracker.consumeInverse()
      : undefined;
    let removeFired = false;
    // Dispatch over a snapshot: listeners that unsubscribe during emit would
    // otherwise splice the live array mid-iteration and skip the next
    // listener. The membership check gives EventTarget semantics — a
    // listener removed by an earlier listener in the same emit does not
    // fire, and one added during the emit waits for the next batch.
    const entries = [...this.#listeners];
    entries.forEach(entry => {
      // The flag (set by #remove) is O(1); a membership scan per listener
      // made dispatch quadratic in the listener count
      if (entry.removed) return;
      try {
        // Filter the diff based on the listener's path
        const filteredDiff = this.#filterDiffByPath(diff, entry.path);
        // A subtree already reported gone stays gone until a later batch
        // lands something at its path again: array growth below a slot
        // that was truncated away restates `$length`, which must not
        // re-notify the slot's listener
        if (filteredDiff === null && entry.gone) return;
        // undefined means the batch didn't touch this listener's subtree.
        // Everything else is meaningful: null (deleted), a leaf (replaced
        // by it), a fragment, or a wholesale container value — an empty
        // one included (`x = []` over an object replaces it; diff nodes
        // are only created when something is recorded, so an empty
        // container is always a real value)
        if (filteredDiff !== undefined) {
          entry.gone = filteredDiff === null;
          // Mark before invoking so a throwing once-listener is still removed
          if (entry.once) {
            entry.fired = true;
            removeFired = true;
          }
          const filteredInverse = inverse === undefined
            ? undefined
            : this.#filterDiffByPath(inverse, entry.path);
          entry.listener(filteredDiff, filteredInverse, meta);
        }
      } catch (e) {
        console.error('Error in LazyWatch listener:', e);
      }
    });
    if (removeFired) {
      for (const entry of this.#listeners) {
        if (entry.fired) this.#remove(entry);
      }
    }
  }

  /**
   * Filter a diff down to a listener's path.
   * @param {Object} diff - The full diff object
   * @param {Array} path - The path to filter by
   * @returns {*} The sub-diff at that path; `null` when the subtree (or an
   *   ancestor of it) was deleted or replaced by a leaf value; the leaf value
   *   itself when the subtree was replaced wholesale; `undefined` when the
   *   batch didn't touch this path at all. (Diffs never store `undefined` —
   *   it is normalized to `null` at write time — so it is a safe sentinel.)
   *
   * Three shapes destroy a listener's slot without naming it in the diff,
   * and each yields `null`: a real array value (a wholesale replacement)
   * that lacks the key; an array fragment whose `$length` truncated the
   * slot away; and a plain object without array markers replacing the
   * array the slot lived in — indistinguishable from an object merge that
   * left the key alone, so that one case consults the live tree.
   * (Structural array ops are recorded per index whenever a listener
   * exists below the array, so a `$splice` node never hides a slot
   * change from a listener registered before the op.)
   */
  #filterDiffByPath(diff, path) {
    if (path.length === 0) {
      // Root listener, return full diff
      return diff;
    }

    // Navigate to the relevant part of the diff
    let current = diff;
    for (let i = 0; i < path.length; i++) {
      const segment = path[i];
      // An ancestor was deleted (null in the diff) or replaced by a leaf
      // value — either way this listener's subtree no longer exists
      if (current === null || !Utils.isObjectOrArray(current)) {
        return null;
      }
      if (Array.isArray(current)) {
        // A real array is a full value: the subtree was replaced
        // wholesale, and a key the new value doesn't carry is gone
        if (!(segment in current)) return null;
        current = current[segment];
        continue;
      }
      if (INDEX_RE.test(segment) && !(segment in current)) {
        if (Utils.hasArrayMarker(current)) {
          // An array fragment: a slot at or beyond the new length was
          // truncated away; anything else is untouched
          return typeof current.$length === 'number' && Number(segment) >= current.$length
            ? null
            : undefined;
        }
        // An unmarked object at an index step: either an object merge that
        // left this key alone, or a plain object that replaced the array
        // the slot lived in. Only the live tree can tell the two apart.
        return this.#pathExists(path.slice(0, i + 1)) ? undefined : null;
      }
      if (!(segment in current)) {
        // No changes at this path
        return undefined;
      }
      current = current[segment];
    }

    return current;
  }

  /**
   * Whether `path` currently resolves in the watched state (true when no
   * resolver was injected, keeping the emitter usable standalone)
   */
  #pathExists(path) {
    return this.#resolveState ? this.#resolveState(path).found : true;
  }

  /**
   * True when any listener is registered strictly below `path`. Structural
   * array ops fall back to per-index recording for such arrays, so those
   * listeners receive exact path-relative diffs.
   */
  hasListenersBelow(path) {
    return this.#listeners.some(entry =>
      entry.path.length > path.length && path.every((segment, i) => entry.path[i] === segment));
  }

  /**
   * Schedule a microtask for emission, keeping at most one live per
   * generation (the same slot discipline as #scheduleCustom). A microtask
   * whose generation was bumped by flush/pause/dispose fires as a no-op.
   */
  #scheduleMicrotask() {
    if (this.#scheduledGeneration === this.#microtaskGeneration) return;
    const generation = this.#microtaskGeneration;
    this.#scheduledGeneration = generation;
    queueMicrotask(() => {
      // Clear only our own marker: a newer microtask may already be live
      if (this.#scheduledGeneration === generation) {
        this.#scheduledGeneration = null;
      }
      if (this.#microtaskGeneration === generation) {
        this.#emit();
      }
    });
  }

  /**
   * Clear any pending emits: invalidate a live microtask or slot and
   * cancel a timer
   */
  #clearPending() {
    this.#microtaskGeneration++;
    clearTimeout(this.#timeoutId);
    this.#timeoutId = null;
  }

  /**
   * Pause event emissions
   * Changes continue to be tracked but listeners won't be notified until resumed
   */
  pause() {
    this.#paused = true;
    this.#clearPending();
  }

  /**
   * Resume event emissions
   * If there are pending changes, they will be emitted
   */
  resume() {
    this.#paused = false;
    // If there are pending changes, schedule an emit
    if (this.#diffTracker.hasPendingChanges()) {
      this.scheduleEmit();
    }
  }

  /**
   * Check if event emissions are paused
   * @returns {boolean} True if paused, false otherwise
   */
  isPaused() {
    return this.#paused;
  }

  /**
   * Force immediate emission of pending changes
   * Bypasses throttle, debounce, and pause state
   * Used internally by silent() to ensure clean state before silent operations
   */
  forceEmit(meta) {
    this.#clearPending();
    if (this.#diffTracker.hasPendingChanges()) {
      this.#emit(meta);
    }
  }

  /**
   * Clean up resources
   */
  dispose() {
    this.#clearPending();
    // Flag and detach every registration (an emit in progress skips them;
    // abort handlers stop referencing this emitter)
    for (const entry of this.#listeners.splice(0)) {
      this.#remove(entry);
    }
  }
}
