// event-emitter.js - Handles event emission with batching
import {Utils} from "./utils.js";
import {preBatchPath} from "./diff-tracker.js";

const INDEX_RE = /^\d+$/;

/**
 * Mark in `value` (a full value, copied) every key a fragment deletes that
 * the value no longer has, recursively through plain objects both have: a
 * listener that merges the value into what it holds then drops them too
 */
function markDeletions(value, fragment) {
  if (!Utils.isPlainObject(value) || !Utils.isPlainObject(fragment) || Utils.hasArrayMarker(fragment)) return;
  for (const key of Object.keys(fragment)) {
    if (Utils.isReservedDiffKey(key) || Utils.isUnsafeKey(key)) continue;
    const part = fragment[key];
    if (part === null) {
      if (!(key in value)) value[key] = null;
    } else if (Utils.isPlainObject(value[key])) {
      markDeletions(value[key], part);
    }
  }
}

/** The part of a fragment at a relative path, or undefined */
function fragmentAt(fragment, path) {
  let node = fragment;
  for (const key of path) {
    if (!Utils.isObjectOrArray(node) || !(key in node)) return undefined;
    node = node[key];
  }
  return node === null ? undefined : node;
}

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
  // nested listener's object survived. Injected by LazyWatch after the
  // handler exists.
  #resolveState = null;
  // (object) => path | null: where a listener's object is now, or null
  // once it has left the tree. Listeners follow their objects: a nested
  // listener is filed under the object it was registered on, and each
  // batch finds it where the batch left it. Injected like #resolveState;
  // standalone, every listener is at the root
  #locate = () => [];
  // Batches consumed but not yet delivered, oldest first, each with its
  // own diff, inverse, metadata, and listener snapshot. Only non-empty
  // while a delivery is running or, while paused, when an implicit flush
  // split a batch off (see #drain)
  #queue = [];
  #dispatching = false;
  // How many queued batches (from the front) must be delivered even while
  // paused: set by an explicit flush
  #forced = 0;
  // Functions called with every batch the moment it is consumed, before
  // any listener and regardless of deferred delivery (the undo manager:
  // its history must be current when a listener calls undo())
  #observers = [];

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
   * Provide where an object is in the watched state: (object) => path | null
   */
  setLocator(locate) {
    this.#locate = locate;
  }

  /**
   * Add a change listener
   * @param {Function} listener - The listener function
   * @param {Object} target - The object this listener is registered on
   *   (the raw object behind the proxy): it receives the diff of that
   *   object wherever it is, `null` when it leaves the tree, and its whole
   *   value if it is put back
   * @param {Object} [options] - Listener options
   * @param {boolean} [options.once=false] - Remove the listener after its first invocation
   * @param {AbortSignal} [options.signal] - Removes the listener when aborted
   * @returns {Function} An idempotent unsubscribe function that removes
   *   exactly this registration
   */
  on(listener, target, options = {}) {
    if (typeof listener !== 'function') {
      throw new TypeError('Listener must be a function');
    }
    const { once = false, signal } = options;
    // Match addEventListener semantics: an already-aborted signal never adds
    if (signal && signal.aborted) return () => {};

    // `path` is where the object was when the last batch ended (the
    // batch after it began there); `attached` whether it was in the tree.
    // A nested object is held weakly: one that left the tree and is
    // otherwise unreachable can never come back, and a listener left
    // registered on it must not keep it alive. The root never leaves
    const path = this.#locate(target);
    const root = path !== null && path.length === 0;
    const entry = {
      listener, target: root ? target : null, ref: root ? null : new WeakRef(target),
      once, removed: false, detach: null, path: path ?? [], attached: path !== null
    };
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
   * Observe every batch at the moment it is consumed: called with
   * (diff, inverse, meta) before any listener, even when delivery to the
   * listeners is deferred because a delivery is already running. For
   * internal consumers whose state must track batch production (the undo
   * manager), not for user listeners
   * @param {Function} observer
   * @returns {Function} Idempotent removal
   */
  observe(observer) {
    // Wrapped so removal targets exactly this registration
    const entry = { observer };
    this.#observers.push(entry);
    return () => {
      const index = this.#observers.indexOf(entry);
      if (index !== -1) this.#observers.splice(index, 1);
    };
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
   * @param {Object} [target] - Only remove the registration made on this
   *   object; when omitted, the first registration of the function is removed
   */
  off(listener, target) {
    const entry = this.#listeners.find(l =>
      l.listener === listener && (target === undefined || (l.target ?? l.ref.deref()) === target));
    if (entry) this.#remove(entry);
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
   * Emit the pending diff: consume it as a batch, then deliver it (and
   * any batch produced while delivering) to the listeners
   * @param {Object} [meta] - Batch metadata handed to every listener as
   *   the third argument (only synchronous emits carry one: flush, and
   *   patch/overwrite called with metadata)
   */
  #emit(meta) {
    this.#produce(meta);
    this.#drain(false);
  }

  /**
   * Consume the pending changes as one batch and queue it for delivery.
   *
   * Consumption is always immediate — the batch boundary is where the
   * caller asked for it, so a flush inside a listener still splits the
   * batch there. Delivery may not be: see #drain. The listener snapshot is
   * taken now, so a batch reaches exactly the listeners registered when it
   * was produced (minus any removed before their turn), as a synchronous
   * delivery would. So is where each listener's object is: the batch's
   * diff describes the tree as the batch left it, which later batches may
   * rearrange before this one is delivered. Observers see the batch now,
   * before any listener.
   */
  #produce(meta) {
    if (!this.#diffTracker.hasPendingChanges()) return;

    this.#lastEmitTime = performance.now();

    const diff = this.#diffTracker.consumeDiff();
    // Consumed in lockstep with the forward diff so the pair always
    // describes the same batch
    const inverse = this.#diffTracker.inverseEnabled
      ? this.#diffTracker.consumeInverse()
      : undefined;
    // Dispatch over a snapshot: listeners that unsubscribe during emit would
    // otherwise splice the live array mid-iteration and skip the next
    // listener. The flag check gives EventTarget semantics — a listener
    // removed by an earlier listener in the same emit does not fire, and
    // one added during the emit waits for the next batch.
    const carried = this.#diffTracker.takeCarried();
    this.#queue.push({ diff, inverse, meta, entries: this.#placeListeners(diff, carried) });
    for (const { observer } of [...this.#observers]) {
      try {
        observer(diff, inverse, meta);
      } catch (e) {
        console.error('Error in LazyWatch listener:', e);
      }
    }
  }

  /**
   * Deliver queued batches oldest-first. While a delivery is running, a
   * batch produced by one of its listeners (a flush, or patch/overwrite
   * with metadata) waits in the queue until the current batch has reached
   * every listener, and the outermost drain delivers it before returning.
   * Delivering it on the spot would hand it to the listeners after the
   * producing one before the batch they are still owed, and a mirror fed
   * by such a listener would apply the two out of order.
   *
   * While paused, queued batches are held (implicit flushes — silent,
   * transaction, patch/overwrite with metadata, the undo manager — still
   * split batches but do not notify) until resume() or an explicit
   * flush. Pause is checked between batches, never within one.
   * @param {boolean} force - Deliver everything queued so far even while
   *   paused (explicit flush). Nested inside a running delivery, the
   *   obligation is handed to the outer drain
   */
  #drain(force) {
    if (force) this.#forced = this.#queue.length;
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      while (this.#queue.length > 0 && (!this.#paused || this.#forced > 0)) {
        if (this.#forced > 0) this.#forced--;
        this.#deliver(this.#queue.shift());
      }
    } finally {
      this.#dispatching = false;
      this.#forced = 0;
    }
  }

  /**
   * Where the batch left each listener's object, for its delivery: its
   * path now (null once it left the tree), where it was when the batch
   * began (the inverse speaks in those positions: preBatchPath, or the
   * last path seen), and its whole value when the diff cannot describe
   * it: it came back into the tree, or went out and back in within the
   * batch, by an op or a write (see #movedValue). An object out of the
   * tree before the batch and after it has nothing to hear, and is left
   * out
   */
  #placeListeners(diff, carried) {
    const placed = [];
    const collected = [];
    // Where the objects that left the tree this batch are, those back in
    // it (see #returnedDepth); usually none, and then no listener looks
    let returned = null;
    for (const object of carried.keys()) {
      const at = this.#locate(object);
      if (at !== null && at.length > 0) (returned ??= []).push(at);
    }
    for (const entry of this.#listeners) {
      const target = entry.target ?? entry.ref.deref();
      const path = target === undefined ? null : this.#locate(target);
      const wasAttached = entry.attached;
      const lastPath = entry.path;
      entry.attached = path !== null;
      if (path !== null) entry.path = path;
      if (path === null && !wasAttached) {
        // Told already; an object garbage-collected since can never return
        if (target === undefined) collected.push(entry);
        continue;
      }
      let before = path === null ? lastPath : wasAttached ? preBatchPath(diff, path) : null;
      let value;
      if (path !== null && !wasAttached) {
        const live = this.#resolveState ? this.#resolveState(path) : { found: false };
        value = live.found ? Utils.deepClone(live.value) : undefined;
      } else if (path !== null) {
        // Out and back in: put in by an op (the diff cannot map it back), or
        // by a write, so something on the way to it left the tree this batch
        const depth = before === null ? this.#insertedDepth(diff, path)
          : returned === null ? 0 : this.#returnedDepth(returned, path);
        if (depth > 0) {
          value = this.#movedValue(diff, carried, path, depth);
          before = lastPath;
        }
      }
      placed.push({ entry, path, before, value });
    }
    for (const entry of collected) this.#remove(entry);
    return placed;
  }

  /**
   * An object that went out of the tree and back in within the batch,
   * the element `depth` long into `path` or below it: the diff carries
   * it whole, in an op's items (a move by splice, push, sort, or reverse)
   * or as a written value, so what the batch changed in it is not there
   * as changes. The listener gets its whole value, with what the batch
   * deleted in it marked, when the batch changed it — as the fragments it
   * carried out (see DiffTracker's #carried) or the diff at its new place
   * show — and nothing when an op only moved it
   */
  #movedValue(diff, carried, path, depth) {
    if (!this.#resolveState) return undefined;
    const element = this.#resolveState(path.slice(0, depth));
    if (!element.found) return undefined;
    // Each carried fragment speaks in the element's own positions as they
    // were when it went out; ops on arrays inside it since it came back in
    // moved them. Newest first: the path is mapped back through the ops
    // recorded after the element returned, looked up, and mapped again
    // through that fragment's own ops for the one before
    let relative = path.slice(depth);
    const fragments = [];
    let since = this.#filterDiffByPath(diff, path.slice(0, depth));
    const trail = carried.get(element.value) ?? [];
    for (let i = trail.length - 1; i >= 0 && relative !== null; i--) {
      if (Utils.isObjectOrArray(since)) relative = preBatchPath(since, relative);
      if (relative === null) break;
      const part = fragmentAt(trail[i], relative);
      if (part !== undefined) fragments.push(part);
      since = trail[i];
    }
    const here = this.#filterDiffByPath(diff, path);
    if (here !== undefined && here !== null) fragments.push(here);
    if (fragments.length === 0) return undefined;
    const live = this.#resolveState(path);
    if (!live.found) return undefined;
    const value = Utils.deepClone(live.value);
    for (const fragment of fragments) markDeletions(value, fragment);
    return value;
  }

  /** The length of the shortest part of `path` the diff's ops cannot map back: the element an op put in */
  #insertedDepth(diff, path) {
    let depth = 1;
    while (depth < path.length && preBatchPath(diff, path.slice(0, depth)) !== null) depth++;
    return depth;
  }

  /**
   * The length of the shortest part of `path` holding an object that left
   * the tree this batch (it carried its changes out, see
   * DiffTracker.recordContainerLoss) and is back: put back by a write. 0
   * when there is none. `returned` are those objects' paths
   */
  #returnedDepth(returned, path) {
    let depth = 0;
    for (const at of returned) {
      if (at.length > path.length || (depth > 0 && at.length >= depth)) continue;
      let i = 0;
      while (i < at.length && String(at[i]) === String(path[i])) i++;
      if (i === at.length) depth = at.length;
    }
    return depth;
  }

  /**
   * Hand one batch to every listener in its snapshot
   */
  #deliver({ diff, inverse, meta, entries }) {
    for (const { entry, path, before, value } of entries) {
      // The flag (set by #remove) is O(1); a membership scan per listener
      // made dispatch quadratic in the listener count
      if (entry.removed) continue;
      try {
        // The listener's part of the diff: the object's whole value when it
        // came back into the tree (the listener was told it had gone),
        // null when it left, else the diff at where it is now. undefined
        // means the batch didn't touch the object. Everything else is
        // meaningful: a leaf (replaced by it), a fragment, or a wholesale
        // container value — an empty one included (`x = []` over an object
        // replaces it; diff nodes are only created when something is
        // recorded, so an empty container is always a real value)
        const filteredDiff = value !== undefined ? value
          : path === null ? null
          : this.#filterDiffByPath(diff, path);
        if (filteredDiff === undefined) continue;
        // Remove before invoking: a throwing once-listener is still
        // removed, and an emit the listener triggers synchronously cannot
        // deliver to it a second time. Removal splices the live list,
        // never the snapshot being iterated
        if (entry.once) this.#remove(entry);
        // An object the batch put there has nothing to restore: undo
        // removes it
        const filteredInverse = inverse === undefined ? undefined
          : before === null ? null
          : this.#filterDiffByPath(inverse, before);
        entry.listener(filteredDiff, filteredInverse, meta);
      } catch (e) {
        console.error('Error in LazyWatch listener:', e);
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
   * Three shapes destroy what is at a path without naming it in the
   * diff, and each yields `null`: a real array value (a wholesale
   * replacement) that lacks the key; an array fragment whose `$length`
   * truncated the index away; and a plain object without array markers
   * replacing the array the path ran through — indistinguishable from an
   * object merge that left the key alone, so that one case consults the
   * live tree. (A listener's own object is located before this: an object
   * the batch left in the tree is at `path`, and the diff's index keys
   * name the positions the batch's `$splice` ops left them at.)
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
   * Batches held while paused are delivered now, oldest first; pending
   * changes are scheduled as usual
   */
  resume() {
    this.#paused = false;
    this.#drain(false);
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
   * End the pending batch now and emit it synchronously, bypassing
   * batching, throttle, and debounce — but not pause: while paused the
   * batch is held (still a separate batch, metadata attached) and
   * delivered by resume() or an explicit flush. The implicit flush used by
   * silent(), transaction(), patch/overwrite with metadata, and the undo
   * manager, which need a batch boundary rather than a notification
   */
  forceEmit(meta) {
    this.#clearPending();
    this.#emit(meta);
  }

  /**
   * LazyWatch.flush: like forceEmit, but also bypasses pause, delivering
   * any held batches and then this one
   */
  flush(meta) {
    this.#clearPending();
    this.#produce(meta);
    this.#drain(true);
  }

  /**
   * Clean up resources
   */
  dispose() {
    this.#clearPending();
    this.#queue.length = 0;
    this.#observers.length = 0;
    // Flag and detach every registration (an emit in progress skips them;
    // abort handlers stop referencing this emitter)
    for (const entry of this.#listeners.splice(0)) {
      this.#remove(entry);
    }
  }
}
