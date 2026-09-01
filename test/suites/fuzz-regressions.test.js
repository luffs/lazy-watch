// fuzz-regressions.test.js - Bugs found by the convergence fuzzer (test/fuzz/),
// each pinned as a focused test so it stays fixed without the fuzzer
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, assertThrows, assertConverged, assertComposeEquivalent, wait } from '../helpers.js';

// Key-order-insensitive comparison: recreated containers may list keys in a
// different order on the sender and on a mirror
const canon = v => Array.isArray(v) ? '[' + Array.from(v, canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  : JSON.stringify(v === undefined ? null : v);
const assertSameState = (a, b, message) =>
  assertEquals(canon(LazyWatch.resolveIfProxy(a)), canon(LazyWatch.resolveIfProxy(b)), message);

const mirrorOf = (src, initial) => {
  const mirror = new LazyWatch(initial);
  LazyWatch.on(src, d => LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d))));
  return mirror;
};

export default function register(runner) {
  runner.test('a plain object assigned over an array should replace it, locally and on mirrors', async () => {
    const src = new LazyWatch({ list: [1, 2], empty: [3] });
    const mirror = mirrorOf(src, { list: [1, 2], empty: [3] });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.list = { e: 17 }; // used to merge `e` into the array as a junk property
    src.empty = {};
    await wait(5);
    assertEquals(LazyWatch.snapshot(src), { list: { e: 17 }, empty: {} });
    assertEquals(diffs, [{ list: { e: 17 }, empty: {} }]);
    assertConverged(src, mirror);
    assertTrue(!Array.isArray(LazyWatch.resolveIfProxy(mirror.list)), 'the mirror replaced its array');

    const plain = { list: [1, 2] };
    LazyWatch.patch(plain, { list: { e: 17 } });
    assertEquals(plain, { list: { e: 17 } });
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  runner.test('array nodes should carry $length even when only something below them changed', async () => {
    const src = new LazyWatch({ todos: [{ done: false }, { done: false }] });
    let diff;
    LazyWatch.on(src, d => { diff = d; });

    src.todos[1].done = true;
    await wait(5);
    assertEquals(diff, { todos: { 1: { done: true }, $length: 2 } });

    // Self-describing: a receiver lacking the field revives an array
    const fresh = new LazyWatch({});
    LazyWatch.patch(fresh, JSON.parse(JSON.stringify(diff)));
    assertTrue(Array.isArray(fresh.todos));
    assertEquals(fresh.todos.length, 2);
    LazyWatch.dispose(src);
    LazyWatch.dispose(fresh);
  });

  runner.test('assigning an array and mutating it in the same batch must not leak diff bookkeeping into state', async () => {
    const src = new LazyWatch({});
    const mirror = mirrorOf(src, {});
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.list = ['a'];
    src.list.push('b');
    src.arr = ['x'];
    src.arr.pop();
    await wait(5);
    // `$length` used to land on the live array (the diff node WAS the array)
    assertEquals(Object.keys(LazyWatch.resolveIfProxy(src.list)), ['0', '1']);
    assertEquals(Object.keys(LazyWatch.resolveIfProxy(src.arr)), []);
    assertEquals(diffs, [{ list: ['a', 'b'], arr: [] }]);
    assertConverged(src, mirror);
    // The array survives validation as a value elsewhere (a reserved key would be rejected)
    src.copy = src.list;
    await wait(5);
    assertConverged(src, mirror);
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  runner.test('truncating then regrowing an array in one batch should delete the gap on receivers', async () => {
    const src = new LazyWatch({ arr: ['a', 'b', 'c'] });
    const mirror = mirrorOf(src, { arr: ['a', 'b', 'c'] });
    let diff;
    LazyWatch.on(src, d => { diff = d; });

    src.arr.length = 0;
    src.arr[2] = 'z';
    await wait(5);
    assertEquals(diff, { arr: { 0: null, 1: null, 2: 'z', $length: 3 } });
    assertConverged(src, mirror, 'the mirror must not keep a and b');
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  runner.test('a $length truncation applied through patch should capture the truncated elements in the inverse', async () => {
    const src = new LazyWatch({ b: [false, 'x'] }, { inverse: true });
    let inverse;
    LazyWatch.on(src, (d, inv) => { inverse = inv; });

    LazyWatch.patch(src, { b: { $length: 0 } });
    await wait(5);
    assertEquals(inverse, { b: { 0: false, 1: 'x', $length: 2 } });
    LazyWatch.patch(src, inverse);
    await wait(5);
    assertEquals(LazyWatch.snapshot(src), { b: [false, 'x'] });
    LazyWatch.dispose(src);
  });

  runner.test('transaction rollback should restore an array whose inverse was first recorded below it', () => {
    const src = new LazyWatch({ a: { c: [63, [1], 0] } });
    assertThrows(() => LazyWatch.transaction(src, () => {
      src.a.c[1][0] = 2;  // creates the inverse node for `c` as an ancestor
      delete src.a.c;     // then records the whole array into it
      throw new Error('rollback');
    }));
    assertTrue(Array.isArray(LazyWatch.resolveIfProxy(src.a.c)), 'restored as an array, not an index-keyed object');
    assertEquals(LazyWatch.snapshot(src), { a: { c: [63, [1], 0] } });
    LazyWatch.dispose(src);
  });

  runner.test('the inverse should delete keys added below a container deleted and recreated in one batch', async () => {
    const original = { d: { c: { c: 'v11' }, e: [10] } };
    const src = new LazyWatch(LazyWatch.Utils.deepClone(original), { inverse: true });
    let inverse;
    LazyWatch.on(src, (d, inv) => { inverse = inv; });

    delete src.d;
    src.d = { b: 0, c: { c: 1 } };
    LazyWatch.overwrite(src.d.c, { c: 87, a: false }); // `a` is new below the recreated container
    await wait(5);
    LazyWatch.patch(src, inverse);
    await wait(5);
    assertEquals(LazyWatch.snapshot(src), original);
    LazyWatch.dispose(src);
  });

  runner.test('the inverse of a kind change should restore the array even after writes into the new object', async () => {
    const src = new LazyWatch({ d: [1, { x: 1 }] }, { inverse: true });
    let inverse;
    LazyWatch.on(src, (d, inv) => { inverse = inv; });

    src.d[1].x = 2;      // an array fragment is recorded for `d` first
    src.d = { k: 1 };    // then the array is replaced by an object
    src.d.y = 2;         // writes into the object must not corrupt the array fragment
    await wait(5);
    LazyWatch.patch(src, inverse);
    await wait(5);
    assertEquals(LazyWatch.snapshot(src), { d: [1, { x: 1 }] });
    assertTrue(Array.isArray(LazyWatch.resolveIfProxy(src.d)));
    LazyWatch.dispose(src);
  });

  runner.test('composeDiffs should delete the gap between an older truncation and newer growth', () => {
    const older = { arr: { $length: 2 } };
    const newer = { arr: { 4: 'x', $length: 5 } };
    assertEquals(LazyWatch.composeDiffs(older, newer), { arr: { 2: null, 3: null, 4: 'x', $length: 5 } });
    assertComposeEquivalent({ arr: [1, 2, 3, 4, 5] }, older, newer);
  });

  runner.test('composeDiffs should drop older index writes that a newer truncation destroyed', () => {
    const older = { arr: { 0: { a: 1 }, $length: 3 } };
    const newer = { arr: { $length: 0 } };
    assertEquals(LazyWatch.composeDiffs(older, newer), { arr: { $length: 0 } });
    assertComposeEquivalent({ arr: [{ z: 9 }, 2, 3] }, older, newer);
    // Refilling the truncated slot with an object has no single-diff form
    assertThrows(() => LazyWatch.composeDiffs({ arr: { $length: 0 } }, { arr: { 0: { b: 2 }, $length: 1 } }));
  });

  runner.test('composeDiffs should refuse an array followed by a plain object, and revive a fragment after an object', () => {
    assertThrows(() => LazyWatch.composeDiffs({ x: [1] }, { x: { a: 1 } }));
    assertThrows(() => LazyWatch.composeDiffs({ x: { 0: 1, $length: 1 } }, { x: { a: 1 } }));
    assertEquals(LazyWatch.composeDiffs({ x: { a: 1 } }, { x: { 0: 'q', $length: 1 } }), { x: ['q'] });
    assertComposeEquivalent({ x: { a: 0, b: 1 } }, { x: { a: 1 } }, { x: { 0: 'q', $length: 1 } });
  });

  runner.test('a key deleted before its container changes kind twice in one batch should still be deleted on receivers', async () => {
    const src = new LazyWatch({ d: { b: 'v1', c: 'v2' } });
    const mirror = mirrorOf(src, { d: { b: 'v1', c: 'v2' } });
    let diff;
    LazyWatch.on(src, d => { diff = d; });

    delete src.d.c;
    src.d = [1];
    src.d = { b: 'v1', e: 3 };
    await wait(5);
    assertEquals(diff, { d: { b: 'v1', e: 3, c: null } });
    assertConverged(src, mirror);
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  runner.test('a subtree lost with its parent and recreated as another kind should still null-fill on receivers', async () => {
    const src = new LazyWatch({ e: { a: { c: 76, d: 0 } } });
    const mirror = mirrorOf(src, { e: { a: { c: 76, d: 0 } } });
    let diff;
    LazyWatch.on(src, d => { diff = d; });

    delete src.e;
    src.e = { x: 1 };
    src.e.a = [1];
    src.e.a = { d: 3 };
    await wait(5);
    assertEquals(diff, { e: { x: 1, a: { d: 3, c: null } } });
    assertSameState(src, mirror, 'the mirror must drop e.a.c');
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  runner.test('a nested listener should receive an empty container that replaces its subtree', async () => {
    const src = new LazyWatch({ b: { x: 1 }, c: [1] });
    const log = [];
    LazyWatch.on(src.b, d => log.push(['b', d]));
    LazyWatch.on(src.c, d => log.push(['c', d]));

    src.b = [];
    src.c = {};
    await wait(5);
    assertEquals(log, [['b', []], ['c', {}]]);
    LazyWatch.dispose(src);
  });

  runner.test('object elements of a real array replacing a lost array should carry markers for stale keys', async () => {
    const src = new LazyWatch({ b: [{ d: -1, k: 1 }] });
    const mirror = mirrorOf(src, { b: [{ d: -1, k: 1 }] });
    const shadow = { v: LazyWatch.snapshot(src.b[0]) };
    LazyWatch.on(src.b[0], d => LazyWatch.patch(shadow, { v: d }));
    let diff;
    LazyWatch.on(src, d => { diff = d; });

    delete src.b;
    src.b = [{ e: 1, k: 2 }];
    await wait(5);
    assertEquals(diff, { b: [{ e: 1, k: 2, d: null }] });
    assertEquals(canon(shadow.v), canon({ e: 1, k: 2 }), 'a listener fed only by its deliveries must drop the stale key');
    assertSameState(src, mirror);
    assertEquals(canon(LazyWatch.snapshot(mirror)), canon({ b: [{ e: 1, k: 2 }] }), 'receivers drop the markers when applying wholesale');
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });
}
