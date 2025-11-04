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
   */
  on(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Listener must be a function');
    }
    this.#listeners.push(listener);
  }

  /**
   * Remove a change listener
   */
  off(listener) {
    const index = this.#listeners.indexOf(listener);
    if (index !== -1) {
      this.#listeners.splice(index, 1);
    }
  }

  /**
   * Schedule a diff emission
   */
  scheduleEmit() {
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
    this.#listeners.forEach(listener => {
      try {
        listener(diff);
      } catch (e) {
        console.error('Error in LazyWatch listener:', e);
      }
    });
  }

  /**
   * Clear any pending emits
   */
  #clearPending() {
    this.#context.clearImmediate(this.#immediateId);
    clearTimeout(this.#timeoutId);
  }

  /**
   * Clean up resources
   */
  dispose() {
    this.#clearPending();
    this.#listeners = [];
  }
}
