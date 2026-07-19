// diff-compose.js - Pure composition of sequential diffs
import {Utils} from "./utils.js";

const INDEX_RE = /^\d+$/;

/**
 * Throw a composability error naming the offending path. TypeError matches
 * the library's other rejection sites; the message tells the caller the
 * safe fallback.
 */
function fail(path, reason) {
  const at = path.length ? ` at "${path.join('.')}"` : '';
  throw new TypeError(
    `LazyWatch.composeDiffs cannot compose${at}: ${reason}. ` +
    `Apply the diffs separately instead (or resync with snapshot + overwrite).`
  );
}

/** Diffs never store undefined, but hand-built sources may; the appliers
 * treat it as a deletion, so composition does too. */
function normalize(value) {
  return value === undefined ? null : value;
}

/**
 * Compose two sequential diff fragments into one, such that patching the
 * result equals patching `a` then `b` — for any receiver the pair itself
 * would have converged (composition adds no new drift assumptions, but
 * cannot remove patch's own).
 *
 * Node-level rules:
 * - Keys only in one fragment carry over.
 * - `$splice` op lists concatenate (receivers apply them in order), which
 *   is only sound when `b`'s ops don't jump the queue past `a`'s index
 *   writes — receivers apply all ops before a node's other keys, so that
 *   pairing throws.
 * - `length` from `b` wins; `a`'s is kept only when `b` doesn't restate it
 *   and has no ops (ops change the length, staling `a`'s).
 *
 * Shared keys defer to composeValue. Everything placed in the result is
 * deep-cloned, so the output shares no references with either input.
 *
 * @param {Object} a - The older fragment
 * @param {Object} b - The newer fragment
 * @param {Function} applyFragment - (container, fragment) => void; applies a
 *   fragment to a real container with receiver patch semantics. Used to
 *   materialize a fragment onto a wholesale container value.
 * @param {Array} path - Current path, for error messages
 * @returns {Object} The composed fragment
 */
export function composeFragments(a, b, applyFragment, path = []) {
  const aOps = Array.isArray(a.$splice) ? a.$splice : null;
  const bOps = Array.isArray(b.$splice) ? b.$splice : null;

  if (bOps) {
    // Receivers apply a node's $splice ops before its index keys, so a's
    // index writes cannot stay chronologically before b's ops in a single
    // fragment. A pure-op `a` (only $splice and length) is fine: the op
    // lists concatenate, and a's interim length is dropped below — it
    // equals the post-op length on any aligned receiver, so only the
    // final length matters.
    for (const key of Object.keys(a)) {
      if (INDEX_RE.test(key)) {
        fail(path, 'the older diff writes array indices, and the newer ' +
          "diff's $splice ops would be applied before them, reordering history");
      }
    }
  }

  const out = {};
  if (aOps || bOps) {
    out.$splice = Utils.deepClone([...(aOps || []), ...(bOps || [])]);
  }

  for (const key of Object.keys(a)) {
    if (key === '$splice' || key === 'length' || Utils.isUnsafeKey(key)) continue;
    if (!(key in b)) out[key] = Utils.deepClone(normalize(a[key]));
  }
  for (const key of Object.keys(b)) {
    if (key === '$splice' || key === 'length' || Utils.isUnsafeKey(key)) continue;
    const bv = normalize(b[key]);
    out[key] = (key in a)
      ? composeValue(normalize(a[key]), bv, applyFragment, [...path, key])
      : Utils.deepClone(bv);
  }

  if ('length' in b) out.length = b.length;
  else if ('length' in a && !bOps) out.length = a.length;
  return out;
}

/**
 * Compose one key's older value with its newer value.
 *
 * - `null` or a leaf in `b` wins outright: receivers apply those wholesale,
 *   so whatever `a` did first is invisible.
 * - A real array in `b` also wins: array values are self-describing (their
 *   `length` truncates), so patching one onto any aligned target yields
 *   exactly that array.
 * - A fragment in `b` over a wholesale container in `a` is materialized:
 *   the fragment is applied to a clone of the container, producing the
 *   value a sequential receiver would hold.
 * - A fragment in `b` over a fragment in `a` composes recursively.
 * - A fragment in `b` over `null`/a leaf in `a` throws — sequentially the
 *   fragment lands on nothing and becomes the exact value, but a single
 *   composed diff would merge it into the receiver's stale container,
 *   which patch cannot express for objects. (Array fragments escape via
 *   revival: they become a real array, which is self-describing.)
 */
function composeValue(av, bv, applyFragment, path) {
  if (bv === null) return null;
  if (!Utils.isObjectOrArray(bv)) return Utils.deepClone(bv); // leaf: primitive, Date, RegExp
  if (Array.isArray(bv)) return Utils.deepClone(bv); // wholesale array replaces anything

  // bv is a plain-object fragment (object diff, array fragment, or a full
  // object value — the wire format cannot distinguish the last two)
  if (av === null || !Utils.isObjectOrArray(av)) {
    if (Utils.isArrayDiff(bv)) return Utils.deepClone(Utils.reviveArrayDiffs(bv));
    fail(path, 'a deletion or leaf write followed by an object diff has no ' +
      'single-diff representation (the object diff would merge into the ' +
      "receiver's stale value instead of replacing it)");
  }
  if (Array.isArray(av)) {
    const materialized = Utils.deepClone(av);
    applyFragment(materialized, bv);
    return materialized;
  }
  return composeFragments(av, bv, applyFragment, path);
}
