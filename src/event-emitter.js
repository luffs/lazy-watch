// event-emitter.js - Handles event emission with batching
import {Utils} from "./utils.js";

export class EventEmitter {
  #listeners = [];
  #diffTracker;
  #microtaskGeneration = 0;
  #timeoutId = null;
  #throttle;
  #debounce;
  #lastEmitTime = 0;
  #paused = false;

  constructor(diffTracker, options = {}) {
    if (!diffTracker) {
      throw new TypeError('EventEmitter requires a DiffTracker instance');
    }
    this.#diffTracker = diffTracker;
    this.#throttle = options.throttle || 0;
    this.#debounce = options.debounce || 0;
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

    const entry = { listener, path, once };
    if (signal) {
      // Remove only this registration: the same function may also be
      // registered on other paths (or on this one without the signal)
      signal.addEventListener('abort', () => this.#remove(entry), { once: true });
    }
    this.#listeners.push(entry);
    return () => this.#remove(entry);
  }

  #remove(entry) {
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
    const index = this.#listeners.findIndex(l =>
      l.listener === listener && (path === undefined || this.#samePath(l.path, path)));
    if (index !== -1) {
      this.#listeners.splice(index, 1);
    }
  }

  #samePath(a, b) {
    return a.length === b.length && a.every((segment, i) => segment === b[i]);
  }

  /**
   * Schedule a diff emission
   */
  scheduleEmit() {
    // Skip scheduling if paused
    if (this.#paused) return;

    // Clear any existing pending emits
    this.#clearPending();

    if (this.#debounce > 0) {
      // Debouncing: delay emission until debounce period passes with no new changes
      // Each new change resets the timer
      this.#timeoutId = setTimeout(() => this.#emit(), this.#debounce);
    } else if (this.#throttle > 0) {
      // Throttling: ensure emissions happen at most once per throttle period
      const now = performance.now();
      const timeSinceLastEmit = now - this.#lastEmitTime;

      if (timeSinceLastEmit >= this.#throttle) {
        // Enough time has passed, emit immediately (on next tick)
        this.#scheduleMicrotask();
      } else {
        // Not enough time has passed, schedule for later
        const delay = this.#throttle - timeSinceLastEmit;
        this.#timeoutId = setTimeout(() => this.#emit(), delay);
      }
    } else {
      // No throttling or debouncing, emit immediately (on next tick)
      this.#scheduleMicrotask();
    }
  }

  /**
   * Emit the current diff to all listeners
   */
  #emit() {
    if (!this.#diffTracker.hasPendingChanges()) return;

    this.#lastEmitTime = performance.now();

    const diff = this.#diffTracker.consumeDiff();
    // Consumed in lockstep with the forward diff so the pair always
    // describes the same batch
    const inverse = this.#diffTracker.inverseEnabled
      ? this.#diffTracker.consumeInverse()
      : undefined;
    let removeFired = false;
    this.#listeners.forEach(entry => {
      try {
        // Filter the diff based on the listener's path
        const filteredDiff = this.#filterDiffByPath(diff, entry.path);
        // undefined means the batch didn't touch this listener's subtree;
        // an empty object means a diff node was created but nothing was
        // recorded in it. null and leaf values are meaningful: the subtree
        // was deleted or replaced wholesale.
        const hasChanges = filteredDiff !== undefined &&
          !(Utils.isObjectOrArray(filteredDiff) && Object.keys(filteredDiff).length === 0);
        if (hasChanges) {
          // Mark before invoking so a throwing once-listener is still removed
          if (entry.once) {
            entry.fired = true;
            removeFired = true;
          }
          const filteredInverse = inverse === undefined
            ? undefined
            : this.#filterDiffByPath(inverse, entry.path);
          entry.listener(filteredDiff, filteredInverse);
        }
      } catch (e) {
        console.error('Error in LazyWatch listener:', e);
      }
    });
    if (removeFired) {
      this.#listeners = this.#listeners.filter(entry => !entry.fired);
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
   */
  #filterDiffByPath(diff, path) {
    if (path.length === 0) {
      // Root listener, return full diff
      return diff;
    }

    // Navigate to the relevant part of the diff
    let current = diff;
    for (const segment of path) {
      // An ancestor was deleted (null in the diff) or replaced by a leaf
      // value — either way this listener's subtree no longer exists
      if (current === null || !Utils.isObjectOrArray(current)) {
        return null;
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
   * Schedule a microtask for emission, cancelling any previous one
   */
  #scheduleMicrotask() {
    const generation = ++this.#microtaskGeneration;
    queueMicrotask(() => {
      if (this.#microtaskGeneration === generation) {
        this.#emit();
      }
    });
  }

  /**
   * Clear any pending emits
   */
  #clearPending() {
    this.#microtaskGeneration++;
    clearTimeout(this.#timeoutId);
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
  forceEmit() {
    this.#clearPending();
    if (this.#diffTracker.hasPendingChanges()) {
      this.#emit();
    }
  }

  /**
   * Clean up resources
   */
  dispose() {
    this.#clearPending();
    this.#listeners = [];
  }
}
