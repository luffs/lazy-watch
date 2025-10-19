// event-emitter.js - Handles event emission with batching
export class EventEmitter {
  #listeners = [];
  #diffTracker;
  #emitTimeout = null;
  #context;
  #throttle;
  #lastEmitTime = 0;

  constructor(diffTracker, context, options = {}) {
    if (!diffTracker) {
      throw new TypeError('EventEmitter requires a DiffTracker instance');
    }
    this.#diffTracker = diffTracker;
    this.#context = context;
    this.#throttle = options.throttle || 0;
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
    this.#context.clearImmediate(this.#emitTimeout);

    if (this.#throttle > 0) {
      const now = performance.now();
      const timeSinceLastEmit = now - this.#lastEmitTime;

      if (timeSinceLastEmit >= this.#throttle) {
        // Enough time has passed, emit immediately (on next tick)
        this.#emitTimeout = this.#context.setImmediate(() => this.#emit());
      } else {
        // Not enough time has passed, schedule for later
        const delay = this.#throttle - timeSinceLastEmit;
        this.#emitTimeout = setTimeout(() => this.#emit(), delay);
      }
    } else {
      // No throttling, emit immediately (on next tick)
      this.#emitTimeout = this.#context.setImmediate(() => this.#emit());
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
   * Clean up resources
   */
  dispose() {
    this.#context.clearImmediate(this.#emitTimeout);
    clearTimeout(this.#emitTimeout);
    this.#listeners = [];
  }
}
