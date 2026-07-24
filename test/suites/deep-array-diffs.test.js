// deep-array-diffs.test.js - Deep array diffs (element-wise array-over-array merge)
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertObjectEqual, assertTrue, assertThrows, assertConverged, assertComposeEquivalent, wait } from '../helpers.js';

export default function register(runner) {
  // --- Deep array diffs (element-wise array-over-array merge) ---

  runner.test('array-over-array assignment should record a minimal fragment, not the wholesale array', async () => {
    const watched = new LazyWatch({
      list: [
        { name: 'api', cpu: 1, memory: 100 },
        { name: 'worker', cpu: 0, memory: 50 },
      ]
    });
    let diff = null;
    LazyWatch.on(watched, d => { diff = d; });

    watched.list = [
      { name: 'api', cpu: 2, memory: 100 },
      { name: 'worker', cpu: 0, memory: 50 },
    ];
    await wait(10);

    assertTrue(!Array.isArray(diff.list), 'diff should be a fragment, not a wholesale array');
    assertObjectEqual(diff, { list: { 0: { cpu: 2 } } }, 'only the changed key of the changed element should be recorded');
    assertEquals(LazyWatch.snapshot(watched).list[0].cpu, 2);
    LazyWatch.dispose(watched);
  });

  runner.test('array-over-array assignment should preserve unchanged element identity', async () => {
    const watched = new LazyWatch({ list: [{ id: 1 }, { id: 2 }] });
    const keepRaw = LazyWatch.resolveIfProxy(watched.list[1]);

    watched.list = [{ id: 9 }, { id: 2 }];
    await wait(10);

    assertTrue(LazyWatch.resolveIfProxy(watched.list[1]) === keepRaw,
      'a deep-equal element should keep its identity (cached child proxies stay valid)');
    LazyWatch.dispose(watched);
  });

  runner.test('deep-equal array-over-array assignment should emit nothing', async () => {
    const watched = new LazyWatch({ list: [1, { a: [2, 3] }] });
    let calls = 0;
    LazyWatch.on(watched, () => calls++);

    watched.list = [1, { a: [2, 3] }];
    await wait(10);

    assertEquals(calls, 0, 'no diff should be recorded or emitted');
    LazyWatch.dispose(watched);
  });

  runner.test('array growth and shrink via assignment should record compact fragments and converge', async () => {
    const src = new LazyWatch({ list: [1, 2] });
    const dst = new LazyWatch({ list: [1, 2] });
    const plain = { list: [1, 2] };
    const diffs = [];
    LazyWatch.on(src, d => {
      diffs.push(d);
      LazyWatch.patch(dst, d);
      LazyWatch.patch(plain, d);
    });

    src.list = [1, 2, 3];        // growth
    await wait(10);
    assertObjectEqual(diffs[0], { list: { 2: 3, length: 3 } }, 'growth should record the new index and length');
    assertConverged(src, dst, 'after growth');
    assertEquals(plain.list, [1, 2, 3], 'plain mirror after growth');

    src.list = [9];              // shrink + change
    await wait(10);
    assertObjectEqual(diffs[1], { list: { 0: 9, length: 1 } }, 'shrink should record the changed index and new length');
    assertConverged(src, dst, 'after shrink');
    assertEquals(plain.list, [9], 'plain mirror after shrink');
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('keys missing from an assigned array element should be deleted, locally and on mirrors', async () => {
    const src = new LazyWatch({ list: [{ a: 1, stale: true }] });
    const dst = new LazyWatch({ list: [{ a: 1, stale: true }] });
    let diff = null;
    LazyWatch.on(src, d => { diff = d; LazyWatch.patch(dst, d); });

    src.list = [{ a: 2 }];
    await wait(10);

    assertObjectEqual(diff, { list: { 0: { a: 2, stale: null } } },
      'the dropped key should be recorded as a null deletion');
    assertEquals(LazyWatch.snapshot(src).list, [{ a: 2 }], 'no stale key locally');
    assertConverged(src, dst, 'mirror should drop the stale key too');
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('nested arrays should merge element-wise recursively', async () => {
    const src = new LazyWatch({ matrix: [[1, 2], [3, 4]] });
    const dst = new LazyWatch({ matrix: [[1, 2], [3, 4]] });
    let diff = null;
    LazyWatch.on(src, d => { diff = d; LazyWatch.patch(dst, d); });

    src.matrix = [[1, 2], [3, 5]];
    await wait(10);

    assertObjectEqual(diff, { matrix: { 1: { 1: 5, length: 2 } } },
      'only the changed inner index should be recorded');
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('LazyWatch.overwrite with arrays in the source should emit fragments (snapshot resync case)', async () => {
    const src = new LazyWatch({ procs: [{ name: 'api', cpu: 1 }, { name: 'worker', cpu: 0 }], other: 1 });
    let diff = null;
    LazyWatch.on(src, d => { diff = d; });

    LazyWatch.overwrite(src, { procs: [{ name: 'api', cpu: 7 }, { name: 'worker', cpu: 0 }], other: 1 });
    await wait(10);

    assertObjectEqual(diff, { procs: { 0: { cpu: 7 } } }, 'overwrite should diff arrays element-wise');
    LazyWatch.dispose(src);
  });

  runner.test('a received wholesale array should re-emit as a fragment and converge a relay chain', async () => {
    const a = new LazyWatch({ list: 'leaf' });
    const b = new LazyWatch({ list: [{ x: 1 }, { x: 2 }] }); // drifted: has an array already
    const c = new LazyWatch({ list: [{ x: 1 }, { x: 2 }] });
    let bDiff = null;
    LazyWatch.on(a, d => LazyWatch.patch(b, d));
    LazyWatch.on(b, d => { bDiff = d; LazyWatch.patch(c, d); });

    a.list = [{ x: 1 }, { x: 9 }]; // leaf -> array: wholesale on the wire
    await wait(10); await wait(10);

    assertTrue(!Array.isArray(bDiff.list), 'the relay should re-emit element-wise');
    assertConverged(a, b, 'A and B');
    assertConverged(b, c, 'B and C');
    LazyWatch.dispose(a);
    LazyWatch.dispose(b);
    LazyWatch.dispose(c);
  });

  runner.test('null and hole elements in an assigned array should clear slots like the wholesale write did', async () => {
    const src = new LazyWatch({ list: [1, 2, 3] });
    const dst = new LazyWatch({ list: [1, 2, 3] });
    LazyWatch.on(src, d => LazyWatch.patch(dst, d));

    src.list = [1, null, 3];
    await wait(10);

    const raw = LazyWatch.resolveIfProxy(src.list);
    assertEquals(raw.length, 3, 'length should be kept');
    assertTrue(!(1 in raw), 'the null element should clear the slot');
    assertConverged(src, dst, 'null elements');

    // eslint-disable-next-line no-sparse-arrays
    src.list = [7, , 3]; // sparse source: hole at index 1
    await wait(10);
    assertTrue(!(1 in LazyWatch.resolveIfProxy(src.list)), 'the hole should clear the slot');
    assertConverged(src, dst, 'sparse source');
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('assigning a real array over a plain object should replace it wholesale (regression)', async () => {
    const src = new LazyWatch({ slot: { a: 1 } });
    const dst = new LazyWatch({ slot: { a: 1 } });
    let diff = null;
    LazyWatch.on(src, d => { diff = d; LazyWatch.patch(dst, d); });

    src.slot = [7, 8];
    await wait(10);

    assertTrue(Array.isArray(LazyWatch.resolveIfProxy(src.slot)), 'the slot should become a real array');
    assertTrue(Array.isArray(diff.slot), 'the diff should carry the array wholesale');
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('relayed $splice ops with object elements should not leave stale keys (regression)', async () => {
    const a = new LazyWatch({ list: [{ a: 1 }, { b: 2 }] });
    const b = new LazyWatch({ list: [{ a: 1 }, { b: 2 }] });
    LazyWatch.on(a, d => LazyWatch.patch(b, d));

    a.list.splice(0, 1);
    await wait(10); await wait(10);

    assertEquals(LazyWatch.snapshot(b).list, [{ b: 2 }],
      'the shifted element must fully replace the old slot value on the receiver');
    assertConverged(a, b);
    LazyWatch.dispose(a);
    LazyWatch.dispose(b);
  });

  runner.test('inverse diffs should undo an element-wise array merge', async () => {
    const watched = new LazyWatch({ list: [{ a: 1 }, { b: 2 }] }, { inverse: true });
    let inverse = null;
    LazyWatch.on(watched, (d, inv) => { inverse = inv; });

    watched.list = [{ a: 9, added: true }];
    await wait(10);

    assertEquals(LazyWatch.snapshot(watched).list, [{ a: 9, added: true }]);
    LazyWatch.patch(watched, inverse);
    assertEquals(LazyWatch.snapshot(watched).list, [{ a: 1 }, { b: 2 }],
      'the inverse should restore elements, dropped keys, and length');
    LazyWatch.dispose(watched);
  });

  runner.test('transaction rollback should restore state across an array merge', async () => {
    const watched = new LazyWatch({ list: [1, { x: 1 }] });

    assertThrows(() => LazyWatch.transaction(watched, () => {
      watched.list = [2, { x: 5, y: 6 }, 'extra'];
      throw new Error('boom');
    }));
    assertEquals(LazyWatch.snapshot(watched).list, [1, { x: 1 }], 'rollback should restore the array exactly');
    LazyWatch.dispose(watched);
  });

  runner.test('undo manager should undo and redo array assignments', async () => {
    const watched = new LazyWatch({ list: [{ n: 1 }, { n: 2 }] });
    const manager = LazyWatch.createUndoManager(watched);

    watched.list = [{ n: 1 }, { n: 5 }];
    LazyWatch.flush(watched);
    watched.list = [{ n: 1 }];
    LazyWatch.flush(watched);

    manager.undo();
    assertEquals(LazyWatch.snapshot(watched).list, [{ n: 1 }, { n: 5 }]);
    manager.undo();
    assertEquals(LazyWatch.snapshot(watched).list, [{ n: 1 }, { n: 2 }]);
    manager.redo();
    assertEquals(LazyWatch.snapshot(watched).list, [{ n: 1 }, { n: 5 }]);
    manager.redo();
    assertEquals(LazyWatch.snapshot(watched).list, [{ n: 1 }]);
    manager.dispose();
    LazyWatch.dispose(watched);
  });

  runner.test('two array fragments should compose and match sequential application', async () => {
    const src = new LazyWatch({ list: [{ v: 1 }, { v: 2 }, { v: 3 }] });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.list = [{ v: 1 }, { v: 9 }, { v: 3 }];
    LazyWatch.flush(src);
    src.list = [{ v: 1 }, { v: 9 }];
    LazyWatch.flush(src);

    assertComposeEquivalent({ list: [{ v: 1 }, { v: 2 }, { v: 3 }] }, diffs[0], diffs[1],
      'composed fragments should equal sequential application');
    LazyWatch.dispose(src);
  });
}
