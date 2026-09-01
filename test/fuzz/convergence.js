// convergence.js - Seeded convergence fuzzer
//
// Drives a sender LazyWatch instance through random mutation sequences and
// checks, after every batch, the invariants the library promises:
//
// - wire convergence: a mirror fed the sender's diffs through a JSON round
//   trip holds exactly the sender's state
// - relay convergence: a second mirror fed by the first mirror's re-emitted
//   diffs converges too (relay chains re-emit compactly and correctly)
// - plain convergence: a plain object patched with the same diffs converges
// - compose equivalence: diffs collapsed with composeDiffs (falling back to
//   sequential application where the pair is not composable) converge
// - inverse restore: when inverses are recorded, patching the post-batch
//   state with the inverse yields the pre-batch state
// - nested listeners: a shadow value maintained purely from a nested
//   listener's path-relative deliveries equals the live value at its path
// - detached handles: a write through a stale nested proxy throws exactly
//   when its object is no longer at its path, and never records anything
// - transactions: a throwing callback leaves the state untouched
// - undo manager (undo mode): undoing every step returns to the initial
//   state and redoing every step returns to the final one, with mirrors
//   following along
//
// Everything is deterministic from the seed, so a failure prints a
// reproduction command. Zero dependencies.
import { LazyWatch } from '../../src/lazy-watch.js';

const KEYS = ['a', 'b', 'c', 'd', 'e'];
const MISSING = Symbol('missing');
export const MODES = ['plain', 'inverse', 'undo'];

/** mulberry32: small, fast, and deterministic across engines */
export class Rng {
  constructor(seed) { this.s = seed >>> 0; }
  next() {
    let t = (this.s = (this.s + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n) { return Math.floor(this.next() * n); }
  pick(arr) { return arr[this.int(arr.length)]; }
  chance(p) { return this.next() < p; }
}

// --- Value generation (JSON-safe leaves, small key alphabet so paths collide) ---

function genLeaf(rng) {
  switch (rng.int(5)) {
    case 0: return rng.int(100);
    case 1: return rng.next() < 0.5;
    case 2: return 'v' + rng.int(20);
    case 3: return -rng.int(10) / 4;
    default: return rng.int(3);
  }
}

function genValue(rng, depth = 0) {
  const r = rng.next();
  if (depth >= 3 || r < 0.5) return genLeaf(rng);
  if (r < 0.75) return genObject(rng, depth + 1);
  return genArray(rng, depth + 1);
}

function genObject(rng, depth = 0) {
  const out = {};
  const n = 1 + rng.int(4);
  for (let i = 0; i < n; i++) out[rng.pick(KEYS)] = genValue(rng, depth);
  return out;
}

function genArray(rng, depth = 0) {
  const out = [];
  const n = rng.int(5);
  for (let i = 0; i < n; i++) out.push(genValue(rng, depth));
  return out;
}

// --- Helpers ---

// Bound wrappers: the Utils methods use `this`
const isObjectOrArray = v => LazyWatch.Utils.isObjectOrArray(v);
const deepClone = v => LazyWatch.Utils.deepClone(v);
const roundTrip = value => JSON.parse(JSON.stringify(value));

/** Key-order-insensitive canonical form; holes and undefined become null like JSON */
export function canon(value) {
  if (value === MISSING) return '<missing>';
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + Array.from(value, canon).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** Raw value at path in a plain tree, or MISSING */
function valueAt(root, path) {
  let cur = root;
  for (const seg of path) {
    if (!isObjectOrArray(cur) || !Object.hasOwn(cur, seg)) return MISSING;
    cur = cur[seg];
  }
  return cur;
}

/** Walk down from a proxy along random container keys */
function randomContainer(rng, root) {
  let node = root;
  const path = [];
  for (;;) {
    const keys = Object.keys(node).filter(k => isObjectOrArray(node[k]));
    if (!keys.length || rng.chance(0.35)) return { node, path };
    const k = rng.pick(keys);
    node = node[k];
    path.push(k);
  }
}

/** Every array proxy reachable from root, with its path */
function collectArrays(root, path = [], out = []) {
  if (Array.isArray(root)) out.push({ node: root, path });
  for (const k of Object.keys(root)) {
    if (isObjectOrArray(root[k])) collectArrays(root[k], [...path, k], out);
  }
  return out;
}

function keyFor(rng, node) {
  if (Array.isArray(node)) {
    // Mostly in range; occasionally one past the end, rarely a gap
    const r = rng.next();
    if (r < 0.7 && node.length) return String(rng.int(node.length));
    if (r < 0.95) return String(node.length);
    return String(node.length + 1 + rng.int(2));
  }
  const keys = Object.keys(node);
  return keys.length && rng.chance(0.6) ? rng.pick(keys) : rng.pick(KEYS);
}

// Deterministic comparator that only reads (comparators see raw elements)
const byCanon = (a, b) => {
  const x = canon(a), y = canon(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * A plausible patch/overwrite source derived from a snapshot: some keys
 * changed, some nulled (delete), some containers replaced, and occasionally
 * an array rendered as an index fragment or a $splice fragment.
 */
function perturb(rng, value, depth = 0) {
  if (!isObjectOrArray(value)) return rng.chance(0.3) ? genLeaf(rng) : value;
  if (Array.isArray(value)) {
    const copy = value.map(v => perturb(rng, v, depth + 1));
    const r = rng.next();
    if (r < 0.15 && copy.length) copy.pop();
    else if (r < 0.3) copy.push(genValue(rng, depth + 1));
    if (rng.chance(0.15)) {
      // Index fragment form
      const frag = { $length: copy.length };
      copy.forEach((v, i) => { if (rng.chance(0.5)) frag[i] = v; });
      return frag;
    }
    if (rng.chance(0.1)) {
      // Structural op form: insert at a random position
      const start = rng.int(value.length + 1);
      const items = [genValue(rng, depth + 1)];
      return { $splice: [[start, rng.int(2), items]], $length: value.length + items.length };
    }
    return copy;
  }
  const out = {};
  for (const k of Object.keys(value)) {
    const r = rng.next();
    if (r < 0.15) continue;                      // omitted (overwrite deletes it)
    if (r < 0.25) out[k] = null;                 // explicit delete
    else if (r < 0.35) out[k] = genValue(rng, depth + 1);
    else out[k] = perturb(rng, value[k], depth + 1);
  }
  if (rng.chance(0.3)) out[rng.pick(KEYS)] = genValue(rng, depth + 1);
  return out;
}

// --- Operations on the sender ---

function opSetLeaf(ctx) {
  const { node, path } = randomContainer(ctx.rng, ctx.sender);
  const k = keyFor(ctx.rng, node);
  const v = genLeaf(ctx.rng);
  node[k] = v;
  return `set ${[...path, k].join('.')} = ${JSON.stringify(v)}`;
}

function opSetContainer(ctx) {
  const { node, path } = randomContainer(ctx.rng, ctx.sender);
  const k = keyFor(ctx.rng, node);
  const v = ctx.rng.chance(0.5) ? genObject(ctx.rng, 1) : genArray(ctx.rng, 1);
  node[k] = v;
  return `set ${[...path, k].join('.')} = ${JSON.stringify(v)}`;
}

function opDelete(ctx) {
  const { node, path } = randomContainer(ctx.rng, ctx.sender);
  const keys = Object.keys(node);
  if (!keys.length) return 'delete (nothing to delete)';
  const k = ctx.rng.pick(keys);
  if (ctx.rng.chance(0.5)) {
    delete node[k];
    return `delete ${[...path, k].join('.')}`;
  }
  node[k] = undefined;
  return `set ${[...path, k].join('.')} = undefined`;
}

function opDeleteRecreate(ctx) {
  const { node, path } = randomContainer(ctx.rng, ctx.sender);
  const keys = Object.keys(node).filter(k => isObjectOrArray(node[k]));
  if (!keys.length) return 'delete+recreate (no container)';
  const k = ctx.rng.pick(keys);
  delete node[k];
  const v = ctx.rng.chance(0.5) ? genObject(ctx.rng, 1) : genArray(ctx.rng, 1);
  node[k] = v;
  return `delete+recreate ${[...path, k].join('.')} = ${JSON.stringify(v)}`;
}

function opArray(ctx) {
  const arrays = collectArrays(ctx.sender);
  if (!arrays.length) return 'array op (no arrays)';
  const { node, path } = ctx.rng.pick(arrays);
  const rng = ctx.rng;
  const label = path.join('.') || '<root>';
  switch (rng.int(11)) {
    case 0: { const v = genValue(rng, 2); node.push(v); return `${label}.push(${JSON.stringify(v)})`; }
    case 1: node.pop(); return `${label}.pop()`;
    case 2: node.shift(); return `${label}.shift()`;
    case 3: { const v = genValue(rng, 2); node.unshift(v); return `${label}.unshift(${JSON.stringify(v)})`; }
    case 4: {
      const start = rng.int(node.length + 1);
      const del = rng.int(3);
      const items = Array.from({ length: rng.int(3) }, () => genValue(rng, 2));
      node.splice(start, del, ...items);
      return `${label}.splice(${start}, ${del}, ${JSON.stringify(items).slice(1, -1)})`;
    }
    case 5: node.sort(byCanon); return `${label}.sort()`;
    case 6: node.reverse(); return `${label}.reverse()`;
    case 7: { const n = rng.int(node.length + 1); node.length = n; return `${label}.length = ${n}`; }
    case 8: {
      if (!node.length) return `${label} (empty, no index write)`;
      const i = rng.int(node.length); const v = genValue(rng, 2);
      node[i] = v; return `${label}[${i}] = ${JSON.stringify(v)}`;
    }
    case 9: {
      if (!node.length) return `${label} (empty, no index delete)`;
      const i = rng.int(node.length); delete node[i]; return `delete ${label}[${i}]`;
    }
    default: {
      // Wholesale reassignment of a perturbed copy (element-wise diffing)
      const copy = LazyWatch.snapshot(node).map(v => isObjectOrArray(v) && rng.chance(0.5) ? v : perturbWholesale(rng, v));
      if (rng.chance(0.3)) copy.push(genValue(rng, 2));
      if (rng.chance(0.3) && copy.length) copy.splice(rng.int(copy.length), 1);
      const parent = path.length ? valueAtProxy(ctx.sender, path.slice(0, -1)) : null;
      if (!parent) return `${label} (root array, no wholesale reassign)`;
      parent[path[path.length - 1]] = copy;
      return `${label} = ${JSON.stringify(copy)}`;
    }
  }
}

function perturbWholesale(rng, v) {
  if (!isObjectOrArray(v)) return rng.chance(0.5) ? genLeaf(rng) : v;
  const out = deepClone(v);
  if (Array.isArray(out)) { if (rng.chance(0.5)) out.push(genLeaf(rng)); return out; }
  const keys = Object.keys(out);
  if (keys.length && rng.chance(0.5)) delete out[rng.pick(keys)];
  out[rng.pick(KEYS)] = genLeaf(rng);
  return out;
}

function valueAtProxy(root, path) {
  let cur = root;
  for (const seg of path) {
    if (!isObjectOrArray(cur) || !Object.hasOwn(cur, seg)) return null;
    cur = cur[seg];
  }
  return cur;
}

function opApply(ctx, method) {
  const { node, path } = randomContainer(ctx.rng, ctx.sender);
  let source = perturb(ctx.rng, LazyWatch.snapshot(node));
  if (Array.isArray(node) && !isObjectOrArray(source)) source = [];
  if (Array.isArray(node) && !Array.isArray(source) && !LazyWatch.Utils.isArrayDiff(source)) {
    // A fragment for an array target must be index-keyed; use a wholesale copy instead
    source = LazyWatch.snapshot(node);
  }
  LazyWatch[method](node, source);
  return `${method} ${path.join('.') || '<root>'} <- ${JSON.stringify(source)}`;
}

function opTakeHandle(ctx) {
  const { node, path } = randomContainer(ctx.rng, ctx.sender);
  if (ctx.handles.length >= 6) ctx.handles.shift();
  ctx.handles.push({ proxy: node, path });
  return `take handle ${path.join('.') || '<root>'}`;
}

function opHandleWrite(ctx) {
  if (!ctx.handles.length) return opTakeHandle(ctx);
  const { proxy, path } = ctx.rng.pick(ctx.handles);
  const raw = LazyWatch.resolveIfProxy(ctx.sender);
  const attached = valueAt(raw, path) === LazyWatch.resolveIfProxy(proxy);
  const k = keyFor(ctx.rng, proxy);
  const v = genLeaf(ctx.rng);
  let threw = null;
  try { proxy[k] = v; } catch (e) { threw = e; }
  if (attached && threw) {
    throw ctx.fail(`handle at ${path.join('.') || '<root>'} is attached but the write threw: ${threw.message}`);
  }
  if (!attached && !threw) {
    throw ctx.fail(`handle at ${path.join('.') || '<root>'} is detached but the write was accepted`);
  }
  if (!attached && !/detached/.test(threw.message)) {
    throw ctx.fail(`detached handle threw an unexpected error: ${threw.message}`);
  }
  return `handle write ${path.join('.') || '<root>'}.${k} = ${JSON.stringify(v)} (${attached ? 'attached' : 'detached, threw'})`;
}

function opTransaction(ctx) {
  const before = canon(LazyWatch.snapshot(ctx.sender));
  const inner = [];
  let caught = null;
  try {
    LazyWatch.transaction(ctx.sender, () => {
      inner.push(opSetContainer(ctx));
      inner.push(opArray(ctx));
      inner.push(opDelete(ctx));
      throw new Error('rollback');
    });
  } catch (e) {
    caught = e;
  }
  const label = `transaction (rolled back) { ${inner.join(' ; ')} }`;
  if (!caught || caught.message !== 'rollback') {
    throw ctx.fail(`transaction did not rethrow the callback error: ${label}\n  got: ${caught ? caught.stack : 'no error'}`);
  }
  const after = canon(LazyWatch.snapshot(ctx.sender));
  if (after !== before) {
    throw ctx.fail(`transaction rollback left the state changed: ${label}\n  before: ${before}\n  after:  ${after}`);
  }
  return label;
}

function opUndo(ctx) {
  if (!ctx.manager) return opSetLeaf(ctx);
  const did = ctx.rng.chance(0.5) ? ctx.manager.undo() : ctx.manager.redo();
  return `undo/redo (${did ? 'applied' : 'nothing to do'})`;
}

function opWatch(ctx) {
  // Register a nested listener and keep a shadow fed only by its deliveries.
  // Subscribe at a batch boundary: a listener added mid-batch receives the
  // whole batch, and a snapshot taken mid-batch already contains part of
  // it (a compact $splice op is not idempotent) — the documented reason to
  // subscribe from a consistent state
  LazyWatch.flush(ctx.sender);
  const { node, path } = randomContainer(ctx.rng, ctx.sender);
  if (!path.length) return 'watch (root, skipped)';
  if (ctx.shadows.length >= 4) {
    const old = ctx.shadows.shift();
    old.stop();
  }
  const box = { v: LazyWatch.snapshot(node) };
  const stop = LazyWatch.on(node, d => { LazyWatch.patch(box, { v: d }); });
  ctx.shadows.push({ path, box, stop });
  return `watch ${path.join('.')}`;
}

const OPS = [
  [opSetLeaf, 14], [opSetContainer, 8], [opDelete, 8], [opDeleteRecreate, 3],
  [opArray, 20], [ctx => opApply(ctx, 'patch'), 6], [ctx => opApply(ctx, 'overwrite'), 6],
  [opTakeHandle, 4], [opHandleWrite, 6], [opTransaction, 3], [opWatch, 5], [opUndo, 3]
];
const OP_TOTAL = OPS.reduce((n, [, w]) => n + w, 0);

function pickOp(rng) {
  let r = rng.int(OP_TOTAL);
  for (const [op, w] of OPS) {
    if (r < w) return op;
    r -= w;
  }
  return opSetLeaf;
}

// --- One run ---

function runOne({ seed, mode, steps, runIndex, trace }) {
  const rng = new Rng(seed * 7919 + runIndex * 104729 + MODES.indexOf(mode) * 15485863);
  const initial = genObject(rng, 0);
  const log = [];
  let step = 0;

  const traceLog = [];
  const ctx = {
    rng, handles: [], shadows: [], manager: null, log,
    fail(message) {
      return new Error(
        `Convergence fuzz failure (seed ${seed}, mode ${mode}, run ${runIndex}, step ${step}): ${message}\n` +
        `  initial: ${JSON.stringify(initial)}\n` +
        `  ops:\n    ${log.slice(-20).join('\n    ')}\n` +
        (trace ? `  trace:\n    ${traceLog.slice(-160).join('\n    ')}\n` : '') +
        `  reproduce: npm run fuzz -- --seed ${seed} --mode ${mode} --runs ${runIndex + 1} --steps ${steps}${trace ? ' --trace' : ''}`
      );
    }
  };

  const sender = new LazyWatch(deepClone(initial), mode === 'inverse' ? { inverse: true } : {});
  ctx.sender = sender;
  const wire = new LazyWatch(deepClone(initial));
  const relay = new LazyWatch(deepClone(initial));
  const plain = deepClone(initial);
  const composed = deepClone(initial);
  let buffer = null;
  let preBatch = canon(initial);

  // A failure raised inside a listener would be swallowed by the emitter's
  // error isolation; it is parked here and rethrown after the flush
  let pendingFailure = null;

  LazyWatch.on(sender, (diff, inverse) => {
    const post = LazyWatch.snapshot(sender);
    if (inverse !== undefined) {
      const restored = deepClone(post);
      LazyWatch.patch(restored, roundTrip(inverse));
      if (canon(restored) !== preBatch && !pendingFailure) {
        pendingFailure = ctx.fail(`inverse did not restore the pre-batch state\n  diff:     ${JSON.stringify(diff)}\n  inverse:  ${JSON.stringify(inverse)}\n  expected: ${preBatch}\n  actual:   ${canon(restored)}`);
      }
    }
    preBatch = canon(post);
    LazyWatch.patch(wire, roundTrip(diff));
    LazyWatch.patch(plain, roundTrip(diff));
    const wireDiff = roundTrip(diff);
    if (trace) traceLog.push(`batch (step ${step}): ${JSON.stringify(diff)}`);
    if (buffer === null) {
      buffer = wireDiff;
    } else {
      try {
        buffer = LazyWatch.composeDiffs(buffer, wireDiff);
        if (trace) traceLog.push(`  composed buffer: ${JSON.stringify(buffer)}`);
      } catch (e) {
        if (trace) traceLog.push(`  compose refused (${e.message.split(':')[1]}); buffer applied`);
        LazyWatch.patch(composed, buffer);
        buffer = wireDiff;
      }
    }
  });
  LazyWatch.on(wire, diff => {
    if (trace) traceLog.push(`  wire re-emitted: ${JSON.stringify(diff)}`);
    LazyWatch.patch(relay, roundTrip(diff));
  });

  if (mode === 'undo') ctx.manager = LazyWatch.createUndoManager(sender);

  const check = where => {
    const expected = canon(LazyWatch.snapshot(sender));
    const raw = LazyWatch.resolveIfProxy(sender);
    const mirrors = [['wire mirror', LazyWatch.snapshot(wire)], ['relay mirror', LazyWatch.snapshot(relay)], ['plain mirror', plain]];
    for (const [name, value] of mirrors) {
      if (canon(value) !== expected) {
        throw ctx.fail(`${name} diverged ${where}\n  sender: ${expected}\n  ${name}: ${canon(value)}`);
      }
    }
    for (const shadow of ctx.shadows) {
      const live = valueAt(raw, shadow.path);
      const seen = Object.hasOwn(shadow.box, 'v') ? shadow.box.v : MISSING;
      if (canon(live) !== canon(seen)) {
        throw ctx.fail(`nested listener at ${shadow.path.join('.')} diverged ${where}\n  live:   ${canon(live)}\n  shadow: ${canon(seen)}`);
      }
    }
  };

  const checkComposed = where => {
    if (trace) traceLog.push(`checkpoint ${where}: applying ${JSON.stringify(buffer)} to ${JSON.stringify(composed)}`);
    if (buffer !== null) {
      LazyWatch.patch(composed, buffer);
      buffer = null;
    }
    const expected = canon(LazyWatch.snapshot(sender));
    if (canon(composed) !== expected) {
      throw ctx.fail(`composed mirror diverged ${where}\n  sender:   ${expected}\n  composed: ${canon(composed)}`);
    }
  };

  for (step = 1; step <= steps; step++) {
    const count = 1 + rng.int(3);
    for (let i = 0; i < count; i++) {
      const op = pickOp(rng);
      try {
        log.push(op(ctx));
      } catch (e) {
        if (/Convergence fuzz failure/.test(e.message)) throw e;
        throw ctx.fail(`operation threw: ${e.stack}`);
      }
    }
    LazyWatch.flush(sender);
    LazyWatch.flush(wire);
    if (pendingFailure) throw pendingFailure;
    check(`after step ${step}`);
    if (step % 5 === 0) checkComposed(`at step ${step}`);
  }
  checkComposed('at the end');

  if (ctx.manager) {
    const final = canon(LazyWatch.snapshot(sender));
    let undone = 0;
    if (trace) traceLog.push(`relay before undo-all: ${JSON.stringify(LazyWatch.snapshot(relay))}`);
    while (ctx.manager.undo()) undone++;
    LazyWatch.flush(wire);
    if (trace) traceLog.push(`relay after undo-all: ${JSON.stringify(LazyWatch.snapshot(relay))}`);
    if (canon(LazyWatch.snapshot(sender)) !== canon(initial)) {
      throw ctx.fail(`undoing all ${undone} steps did not return to the initial state\n  expected: ${canon(initial)}\n  actual:   ${canon(LazyWatch.snapshot(sender))}`);
    }
    check('after undoing everything');
    // Redo exactly what was undone: a step the run itself had undone last
    // sits on the redo stack too, and must stay undone
    for (let i = 0; i < undone; i++) ctx.manager.redo();
    LazyWatch.flush(wire);
    if (canon(LazyWatch.snapshot(sender)) !== final) {
      throw ctx.fail(`redoing all steps did not return to the final state\n  expected: ${final}\n  actual:   ${canon(LazyWatch.snapshot(sender))}`);
    }
    check('after redoing everything');
  }

  LazyWatch.dispose(sender);
  LazyWatch.dispose(wire);
  LazyWatch.dispose(relay);
  return log.length;
}

/**
 * Run the fuzzer. Throws on the first invariant violation with a message
 * that includes the reproduction command.
 * @param {Object} options
 * @param {number} [options.seed=1]
 * @param {number} [options.runs=50] - Independent runs per mode
 * @param {number} [options.steps=30] - Batches per run (1-3 ops each)
 * @param {string[]} [options.modes=MODES]
 * @param {boolean} [options.trace=false] - Include every batch diff and
 *   composed buffer in the failure message (for debugging a repro)
 * @returns {{ runs: number, ops: number }}
 */
export function runFuzz({ seed = 1, runs = 50, steps = 30, modes = MODES, trace = false } = {}) {
  let ops = 0;
  let count = 0;
  for (const mode of modes) {
    if (!MODES.includes(mode)) throw new Error(`Unknown fuzz mode "${mode}" (expected one of ${MODES.join(', ')})`);
    for (let runIndex = 0; runIndex < runs; runIndex++) {
      ops += runOne({ seed, mode, steps, runIndex, trace });
      count++;
    }
  }
  return { runs: count, ops };
}
