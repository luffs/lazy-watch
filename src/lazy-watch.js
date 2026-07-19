
import {Utils} from "./utils.js";
import {EventEmitter} from "./event-emitter.js";
import {DiffTracker} from "./diff-tracker.js";
import {ProxyHandler, LAZYWATCH_INSTANCE, PROXY_TARGET} from "./proxy-handler.js";
import {UndoManager} from "./undo-manager.js";
import {composeFragments} from "./diff-compose.js";

/**
 * LazyWatch - A reactive proxy-based object change tracker
 *
 * Returns a proxy that can be used directly. Static methods on LazyWatch
 * can be used to add listeners, remove listeners, and dispose.
 *
 * @example
 * const data = { count: 0 };
 * const watched = new LazyWatch(data);
 *
 * LazyWatch.on(watched, (changes) => {
 *   console.log('Changes:', changes);
 * });
 *
 * watched.count = 1; // Triggers listener with { count: 1 }
 *
 * LazyWatch.dispose(watched);
 */
export class LazyWatch {
  #diffTracker;
  #eventEmitter;
  #proxyHandler;
  #proxy;
  #disposed = false;
  #inTransaction = false;

  static #instances = new WeakMap();
  // One active undo manager per instance; entries are removed on
  // manager disposal so a new one can be created afterwards
  static #undoManagers = new WeakMap();

  /**
   * Create a new LazyWatch instance
   * @param {Object|Array} original - The object or array to watch
   * @param {Object} options - Configuration options
   * @param {number} [options.throttle=0] - Minimum time in milliseconds between emits (default: 0)
   * @param {number} [options.debounce=0] - Time in milliseconds to wait for additional changes before emitting (default: 0)
   * @param {boolean} [options.inverse=false] - Also record an inverse diff per
   *   batch; listeners receive it as a second argument. Applying the inverse
   *   with LazyWatch.patch restores the pre-batch state (undo). Costs extra
   *   clones on the write path and disables compact $splice recording
   *   (structural array ops fall back to per-index diffs — still correct)
   * @returns {Object} A proxy that tracks changes
   * @throws {TypeError} If original is not an object or array
   */
  constructor(original, options = {}) {
    this.#diffTracker = new DiffTracker();
    this.#diffTracker.inverseEnabled = !!options.inverse;
    this.#eventEmitter = new EventEmitter(this.#diffTracker, options);
    this.#proxyHandler = new ProxyHandler(original, this.#diffTracker, this.#eventEmitter);
    this.#proxy = this.#proxyHandler.createRootProxy(this);

    // Store the instance reference so we can access it from the proxy
    LazyWatch.#instances.set(this.#proxy, this);

    // Return the proxy directly. The "|| original" is for better code completion
    return this.#proxy || original;
  }

  /**
   * Get the LazyWatch instance from a watched proxy
   */
  static #getInstance(watched) {
    // Try to get instance from the proxy using our symbol
    try {
      const instance = watched[LAZYWATCH_INSTANCE];
      if (instance) return instance;
    } catch (e) {}

    // Fallback to WeakMap lookup
    const instance = LazyWatch.#instances.get(watched);
    if (!instance) {
      throw new Error('Not a LazyWatch proxy or instance has been disposed');
    }
    return instance;
  }

  /**
   * Add a change listener
   *
   * Listeners on nested proxies receive path-relative diffs; they receive
   * `null` when their subtree (or an ancestor) is deleted, and the new leaf
   * value when the subtree is replaced wholesale.
   * @param {Object} watched - The LazyWatch proxy
   * @param {Function} listener - Callback function that receives changes
   * @param {Object} [options] - Listener options
   * @param {boolean} [options.once=false] - Remove the listener after its first invocation
   * @param {AbortSignal} [options.signal] - Removes the listener when aborted;
   *   an already-aborted signal never adds the listener
   * @returns {Function} An idempotent unsubscribe function that removes
   *   exactly this registration
   * @example
   * const stop = LazyWatch.on(watched, diff => console.log(diff));
   * stop(); // listener removed
   */
  static on(watched, listener, options) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    const path = instance.#proxyHandler.getProxyPath(watched);
    return instance.#eventEmitter.on(listener, path, options);
  }

  /**
   * Add a change listener that is removed after its first invocation.
   * For listeners on nested proxies, "first invocation" means the first
   * batch that actually touches their subtree.
   * @param {Object} watched - The LazyWatch proxy
   * @param {Function} listener - Callback function that receives changes
   * @param {Object} [options] - Listener options
   * @param {AbortSignal} [options.signal] - Removes the listener when aborted
   * @returns {Function} An idempotent unsubscribe function that removes
   *   exactly this registration
   */
  static once(watched, listener, options = {}) {
    return LazyWatch.on(watched, listener, { ...options, once: true });
  }

  /**
   * Remove a change listener
   *
   * Removes the registration made on this specific proxy: the same function
   * registered on the root and on a nested proxy are distinct registrations,
   * and `off` on one leaves the other active.
   * @param {Object} watched - The LazyWatch proxy the listener was registered on
   * @param {Function} listener - The listener to remove
   */
  static off(watched, listener) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    const path = instance.#proxyHandler.getProxyPath(watched);
    instance.#eventEmitter.off(listener, path);
  }

  /**
   * Overwrite the watched object with new values
   * Deletes properties not present in source (unless target is array)
   * @param {Object} watched - The LazyWatch proxy
   * @param {Object} source - The new values
   */
  static overwrite(watched, source) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#proxyHandler.overwrite(watched, source);
  }

  /**
   * Patch (merge) new values without deleting missing properties
   * @param {Object} watched - The LazyWatch proxy
   * @param {Object} source - The values to merge
   */
  static patch(watched, source) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#proxyHandler.patch(watched, source);
  }

  /**
   * Helper method to patch normal (non-proxy) objects
   * @param {Object} target - The target object to patch
   * @param {Object} source - The source object with values to merge
   */
  static patchObject(target, source) {
    // Reject Map/Set/typed arrays etc. anywhere in the source
    Utils.assertSupported(LazyWatch.resolveIfProxy(source));
    LazyWatch.#patchObjectInto(target, source);
  }

  static #patchObjectInto(target, source) {
    const resolvedSource = LazyWatch.resolveIfProxy(source);

    // Apply compact structural array ops before merging the node's other
    // keys, matching the sender-side ordering guarantee. Op items are full
    // values, cloned to prevent reference sharing.
    if (Array.isArray(target) && Array.isArray(resolvedSource.$splice)) {
      for (const op of resolvedSource.$splice) {
        const items = (op[2] || []).map(item =>
          Utils.isObjectOrArray(item) ? Utils.deepClone(item) : item
        );
        target.splice(op[0], op[1], ...items);
      }
    }

    // A real array as the source is a wholesale replacement: adopt its
    // length (for-in never visits the non-enumerable `length`, so without
    // this a shorter source would leave the target's tail behind —
    // `overwrite` on proxies does the same)
    if (Array.isArray(target) && Array.isArray(resolvedSource) &&
      target.length !== resolvedSource.length) {
      target.length = resolvedSource.length;
    }

    for (const prop in resolvedSource) {
      // $splice handled above (or dropped when the target isn't an array);
      // reserved names are never applied — writing them would mutate
      // prototypes instead of data
      if (prop === '$splice' || Utils.isUnsafeKey(prop)) continue;
      if (resolvedSource[prop] === null || resolvedSource[prop] === undefined) {
        delete target[prop];
      } else if (Utils.isObjectOrArray(target[prop]) && Utils.isObjectOrArray(resolvedSource[prop]) &&
        !Array.isArray(resolvedSource[prop]) && !Array.isArray(resolvedSource)) {
        // Recursively patch nested objects. Real arrays are excluded: they
        // are wholesale values (fragments are the merge form), and inside
        // one every entry is a full value too — both replace below, like
        // the proxy appliers.
        LazyWatch.#patchObjectInto(target[prop], resolvedSource[prop]);
      } else {
        // No container to merge into (or the value is a wholesale
        // replacement): revive index-keyed array diffs so they become real
        // arrays instead of being stored as plain objects, and drop null
        // markers — null means delete, and the replacement discards the
        // old container anyway. Cloned, so the caller's source is never
        // mutated or aliased.
        const sourceValue = Utils.reviveArrayDiffs(resolvedSource[prop]);
        const clonedValue = Utils.isObjectOrArray(sourceValue)
          ? Utils.cloneWithoutNulls(sourceValue)
          : sourceValue;
        target[prop] = clonedValue;
      }
    }
  }

  /**
   * Compose two sequential diffs into one equivalent diff.
   *
   * Applying the result with `patch` produces the same state as applying
   * `older` then `newer` — the primitive for offline send buffers (collapse
   * queued diffs into one message) and undo-step coalescing. Pure: neither
   * input is mutated and the result shares no references with them.
   *
   * Composition follows receiver semantics: a `null` or leaf in `newer`
   * wins outright, object fragments merge recursively, `$splice` op lists
   * concatenate, and fragments over wholesale container values are
   * materialized. Two pairings have no single-diff representation and
   * throw a TypeError naming the path: an object diff following a deletion
   * or leaf write (it would merge into the receiver's stale value instead
   * of replacing it), and `$splice` ops following index writes on the
   * same array (receivers apply ops before index keys, which would
   * reorder history). Catch the error and fall back to sending the diffs
   * separately, or resync with `snapshot` + `overwrite`:
   *
   * @param {Object} older - The earlier diff
   * @param {Object} newer - The later diff
   * @returns {Object} A new diff equivalent to applying both in order
   * @throws {TypeError} If either input is not a diff object, contains
   *   unsupported values, or the pair has no single-diff representation
   * @example
   * let buffered = null;
   * LazyWatch.on(watched, diff => {
   *   if (connected) return send(diff);
   *   try {
   *     buffered = buffered ? LazyWatch.composeDiffs(buffered, diff) : diff;
   *   } catch (e) {
   *     resyncOnReconnect = true; // pair can't collapse; send a snapshot later
   *   }
   * });
   */
  static composeDiffs(older, newer) {
    const a = LazyWatch.resolveIfProxy(older);
    const b = LazyWatch.resolveIfProxy(newer);
    if (!a || typeof a !== 'object' || Array.isArray(a) ||
        !b || typeof b !== 'object' || Array.isArray(b)) {
      throw new TypeError('LazyWatch.composeDiffs requires two diff objects');
    }
    // Reject Map/Set/typed arrays, non-finite numbers, and reserved names
    // anywhere in either diff, like the appliers do
    Utils.assertSupported(a);
    Utils.assertSupported(b);
    return composeFragments(a, b,
      (target, fragment) => LazyWatch.#patchObjectInto(target, fragment));
  }

  /**
   * Resolve a proxy to its original target
   * @param {*} obj - Potentially a proxy object
   * @returns {*} The original target or the input if not a proxy
   */
  static resolveIfProxy(obj) {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    try {
      const target = obj[PROXY_TARGET];
      return target ?? obj;
    } catch (e) {
      return obj;
    }
  }

  /**
   * Get a deep-cloned plain snapshot of the current state
   *
   * Works on the root proxy or any nested proxy (snapshotting that subtree).
   * The result shares no references with the watched object, so it can be
   * mutated or serialized freely without affecting tracking.
   * @param {Object} watched - The LazyWatch proxy (or a nested proxy within it)
   * @returns {Object|Array} A deep clone of the underlying data
   * @throws {Error} If the instance has been disposed
   * @example
   * const state = LazyWatch.snapshot(watched);
   * localStorage.setItem('state', JSON.stringify(state));
   */
  static snapshot(watched) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    return Utils.deepClone(LazyWatch.resolveIfProxy(watched));
  }

  /**
   * Get a copy of the current pending diff without consuming it
   * @param {Object} watched - The LazyWatch proxy
   * @returns {Object} A copy of the pending changes
   */
  static getPendingDiff(watched) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    return instance.#diffTracker.getPendingDiff();
  }

  /**
   * Check if an object is a LazyWatch proxy
   * @param {*} obj - The object to check
   * @returns {boolean} True if the object is a LazyWatch proxy, false otherwise
   */
  static isProxy(obj) {
    if (!obj || typeof obj !== 'object') {
      return false;
    }

    // Try to access the LazyWatch instance via symbol
    try {
      const instance = obj[LAZYWATCH_INSTANCE];
      if (instance instanceof LazyWatch && !instance.#disposed) {
        return true;
      }
    } catch (e) {
      // Accessing the symbol might throw in some edge cases
    }

    // Fallback to WeakMap check (which won't find disposed proxies)
    return LazyWatch.#instances.has(obj);
  }

  /**
   * Synchronously emit any pending changes to all listeners.
   * Bypasses microtask batching, throttle, debounce, and pause state.
   * Does nothing if there are no pending changes.
   * @param {Object} watched - The LazyWatch proxy
   * @throws {Error} If the instance has been disposed
   * @example
   * watched.count = 1;
   * LazyWatch.flush(watched); // listener fires now, not on the next microtask
   */
  static flush(watched) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#eventEmitter.forceEmit();
  }

  /**
   * Pause event emissions
   * Changes continue to be tracked but listeners won't be notified until resumed
   * @param {Object} watched - The LazyWatch proxy
   */
  static pause(watched) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#eventEmitter.pause();
  }

  /**
   * Resume event emissions
   * If there are pending changes, they will be emitted
   * @param {Object} watched - The LazyWatch proxy
   */
  static resume(watched) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#eventEmitter.resume();
  }

  /**
   * Check if event emissions are paused
   * @param {Object} watched - The LazyWatch proxy
   * @returns {boolean} True if paused, false otherwise
   */
  static isPaused(watched) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    return instance.#eventEmitter.isPaused();
  }

  /**
   * Execute a callback while suppressing event emissions
   * Any changes made during the callback are tracked and returned as a diff
   *
   * @param {Object} watched - The LazyWatch proxy
   * @param {Function} callback - Function to execute silently
   * @returns {Object} A diff object containing any changes made during the callback
   * @throws {Error} If the instance has been disposed
   * @example
   * const diff = LazyWatch.silent(watched, () => {
   *   watched.count = 1;
   *   watched.name = 'test';
   * });
   * // diff = { count: 1, name: 'test' }
   */
  static silent(watched, callback) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    instance.#eventEmitter.forceEmit()

    let diff = {}
    try {
      callback()
    } finally {
      diff = instance.#diffTracker.consumeDiff()
      // Keep the inverse in lockstep with the forward diff
      instance.#diffTracker.consumeInverse()
    }
    return diff
  }

  /**
   * Execute a callback atomically: if it throws, every change it made to the
   * watched object is rolled back and nothing is emitted; if it succeeds, the
   * changes emit as one normal batch and the callback's return value is
   * returned.
   *
   * Pending changes from before the transaction are flushed (emitted
   * synchronously) first, so the rollback covers exactly the callback's own
   * changes. Works whether or not the instance was created with
   * `{ inverse: true }` — inverse recording is enabled just for the duration.
   * The callback must be synchronous; transactions cannot be nested.
   *
   * @param {Object} watched - The LazyWatch proxy
   * @param {Function} callback - Function whose changes are applied atomically
   * @returns {*} The callback's return value
   * @throws {Error} If the instance has been disposed or a transaction is
   *   already active; rethrows whatever the callback throws (after rollback)
   * @example
   * LazyWatch.transaction(watched, () => {
   *   watched.balance -= 100;
   *   applyFees(watched); // if this throws, balance is restored
   * });
   */
  static transaction(watched, callback) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    if (instance.#inTransaction) {
      throw new Error('LazyWatch.transaction cannot be nested');
    }
    // Start from a clean batch boundary so the inverse covers exactly the
    // callback's changes
    instance.#eventEmitter.forceEmit();

    const tracker = instance.#diffTracker;
    const wasEnabled = tracker.inverseEnabled;
    tracker.inverseEnabled = true;
    instance.#inTransaction = true;
    try {
      return callback();
    } catch (error) {
      const inverse = tracker.consumeInverse();
      tracker.consumeDiff(); // discard the forward diff; nothing may emit
      instance.#proxyHandler.rollback(inverse);
      throw error;
    } finally {
      instance.#inTransaction = false;
      tracker.inverseEnabled = wasEnabled;
      if (!wasEnabled) {
        // The instance doesn't track inverses; drop the one recorded for
        // the callback (after a rollback this is already empty)
        tracker.consumeInverse();
      }
    }
  }

  /**
   * Create an undo/redo manager for a watched instance.
   *
   * Each emitted batch becomes one undoable step. `undo()` restores the
   * state from before the step, `redo()` re-applies it; both emit to the
   * instance's other listeners as a normal batch, so synced mirrors follow
   * undo history automatically. New changes clear the redo stack.
   *
   * Works on any instance: inverse recording is enabled for the manager's
   * lifetime and restored on `manager.dispose()`. While enabled it has the
   * usual costs — extra clones on the write path, compact $splice recording
   * disabled, and listeners receive inverse diffs as a second argument.
   * Pending changes are flushed when the manager attaches, so history
   * starts at a clean batch boundary. Changes made inside
   * `LazyWatch.silent` bypass emission and are not recorded.
   *
   * One manager per instance: creating a second one before disposing the
   * first throws. Disposing the instance disposes its manager.
   *
   * @param {Object} watched - The LazyWatch root proxy
   * @param {Object} [options] - Manager options
   * @param {number} [options.limit=Infinity] - Maximum undo depth; the
   *   oldest step is dropped when exceeded
   * @returns {UndoManager} The manager: `undo()`, `redo()`, `canUndo`,
   *   `canRedo`, `clear()`, `dispose()`
   * @throws {Error} If the instance has been disposed, already has an
   *   undo manager, or a nested proxy is passed
   * @example
   * const manager = LazyWatch.createUndoManager(watched, { limit: 100 });
   * watched.count = 1;
   * manager.undo(); // count restored
   * manager.redo(); // count is 1 again
   */
  static createUndoManager(watched, options = {}) {
    const instance = LazyWatch.#getInstance(watched);
    instance.#checkDisposed();
    if (LazyWatch.#undoManagers.has(instance)) {
      throw new Error('This LazyWatch instance already has an undo manager (dispose it first)');
    }
    if (instance.#proxyHandler.getProxyPath(watched).length > 0) {
      throw new Error('LazyWatch.createUndoManager requires the root proxy, not a nested one');
    }

    // Start history at a clean batch boundary, then enable inverse
    // recording for the manager's lifetime
    instance.#eventEmitter.forceEmit();
    const tracker = instance.#diffTracker;
    const wasEnabled = tracker.inverseEnabled;
    tracker.inverseEnabled = true;

    const manager = new UndoManager({
      limit: options.limit,
      subscribe: listener => instance.#eventEmitter.on(listener, []),
      flush: () => instance.#eventEmitter.forceEmit(),
      patch: diff => instance.#proxyHandler.patch(instance.#proxy, diff),
      hasPending: () => tracker.hasPendingChanges(),
      onDispose: () => {
        tracker.inverseEnabled = wasEnabled;
        // The instance doesn't track inverses itself; drop any
        // half-recorded one so it can't pair with a later batch
        if (!wasEnabled) tracker.consumeInverse();
        LazyWatch.#undoManagers.delete(instance);
      }
    });
    LazyWatch.#undoManagers.set(instance, manager);
    return manager;
  }

  /**
   * Clean up resources and remove all listeners
   * @param {Object} watched - The LazyWatch proxy
   */
  static dispose(watched) {
    const instance = LazyWatch.#getInstance(watched);
    if (instance.#disposed) return;

    // Detach an active undo manager first, while the emitter and tracker
    // are still alive for its cleanup
    const undoManager = LazyWatch.#undoManagers.get(instance);
    if (undoManager) undoManager.dispose();

    instance.#disposed = true;
    instance.#eventEmitter.dispose();
    instance.#proxyHandler.dispose();
    instance.#diffTracker.clear();
    LazyWatch.#instances.delete(watched);
  }

  /**
   * Check if instance has been disposed
   */
  #checkDisposed() {
    if (this.#disposed) {
      throw new Error('LazyWatch instance has been disposed');
    }
  }
}

// Export for backward compatibility
LazyWatch.Utils = Utils;

// Export symbols for advanced usage
export { PROXY_TARGET, LAZYWATCH_INSTANCE };
