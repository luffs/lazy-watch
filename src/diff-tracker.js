// diff-tracker.js - Handles diff tracking
export class DiffTracker {
  #masterDiff = {};

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
   * Get the current master diff and reset it
   */
  consumeDiff() {
    const diff = this.#masterDiff;
    this.#masterDiff = {};
    return diff;
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
    return JSON.parse(JSON.stringify(this.#masterDiff));
  }

  /**
   * Clear all pending diffs
   */
  clear() {
    this.#masterDiff = {};
  }
}