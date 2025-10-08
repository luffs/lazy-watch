// event-emitter.js - Handles event emission with batching
export class EventEmitter {
  #listeners = [];
  #diffTracker;
  #emitTimeout = null;
  #context;

  constructor(diffTracker, context) {
    if (!diffTracker) {
      throw new TypeError('EventEmitter requires a DiffTracker instance');
    }
    this.#diffTracker = diffTracker;
    this.#context = context;
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
    this.#emitTimeout = this.#context.setImmediate(() => this.#emit());
  }

  /**
   * Emit the current diff to all listeners
   */
  #emit() {
    if (!this.#diffTracker.hasPendingChanges()) return;

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
    this.#listeners = [];
  }
}