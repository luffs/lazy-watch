// event-emitter.js - Handles event emission with batching
export class EventEmitter {
  #listeners = [];
  #diffTracker;
  #immediateId = null;
  #timeoutId = null;
  #context;
  #throttle;
  #debounce;
  #lastEmitTime = 0;
  #paused = false;

  constructor(diffTracker, context, options = {}) {
    if (!diffTracker) {
      throw new TypeError('EventEmitter requires a DiffTracker instance');
    }
    this.#diffTracker = diffTracker;
    this.#context = context;
    this.#throttle = options.throttle || 0;
    this.#debounce = options.debounce || 0;
  }

  /**
   * Add a change listener
   * @param {Function} listener - The listener function
   * @param {Array} path - The path of the proxy this listener is registered on
   */
  on(listener, path = []) {
    if (typeof listener !== 'function') {
      throw new TypeError('Listener must be a function');
    }
    this.#listeners.push({ listener, path });
  }

  /**
   * Remove a change listener
   */
  off(listener) {
    const index = this.#listeners.findIndex(l => l.listener === listener);
    if (index !== -1) {
      this.#listeners.splice(index, 1);
    }
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
        this.#immediateId = this.#context.setImmediate(() => this.#emit());
      } else {
        // Not enough time has passed, schedule for later
        const delay = this.#throttle - timeSinceLastEmit;
        this.#timeoutId = setTimeout(() => this.#emit(), delay);
      }
    } else {
      // No throttling or debouncing, emit immediately (on next tick)
      this.#immediateId = this.#context.setImmediate(() => this.#emit());
    }
  }

  /**
   * Emit the current diff to all listeners
   */
  #emit() {
    if (!this.#diffTracker.hasPendingChanges()) return;

    this.#lastEmitTime = performance.now();

    const diff = this.#diffTracker.consumeDiff();
    this.#listeners.forEach(({ listener, path }) => {
      try {
        // Filter the diff based on the listener's path
        const filteredDiff = this.#filterDiffByPath(diff, path);
        // Only call the listener if there are changes relevant to their path
        if (filteredDiff && Object.keys(filteredDiff).length > 0) {
          listener(filteredDiff);
        }
      } catch (e) {
        console.error('Error in LazyWatch listener:', e);
      }
    });
  }

  /**
   * Filter a diff to only include changes at or below a specific path
   * @param {Object} diff - The full diff object
   * @param {Array} path - The path to filter by
   * @returns {Object} The filtered diff
   */
  #filterDiffByPath(diff, path) {
    if (path.length === 0) {
      // Root listener, return full diff
      return diff;
    }

    // Navigate to the relevant part of the diff
    let current = diff;
    for (const segment of path) {
      if (current && typeof current === 'object' && segment in current) {
        current = current[segment];
      } else {
        // No changes at this path
        return {};
      }
    }

    return current;
  }

  /**
   * Clear any pending emits
   */
  #clearPending() {
    this.#context.clearImmediate(this.#immediateId);
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
