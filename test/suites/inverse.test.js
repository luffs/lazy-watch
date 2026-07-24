// inverse.test.js - Inverse diffs and transactions
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, assertThrows, wait } from '../helpers.js';

export default function register(runner) {
  // --- Inverse diffs and transactions ---

  runner.test('listeners should receive an inverse diff when inverse tracking is enabled', async () => {
    const watched = new LazyWatch({ a: 1, nested: { x: 1 } }, { inverse: true });
    let got = null;
    LazyWatch.on(watched, (diff, inverse) => { got = { diff, inverse }; });

    watched.a = 2;
    watched.b = 3;
    delete watched.nested;
    await wait(10);

    assertEquals(got.diff, { a: 2, b: 3, nested: null });
    assertEquals(got.inverse, { a: 1, b: null, nested: { x: 1 } });
    LazyWatch.dispose(watched);
  });

  runner.test('listeners should not receive an inverse when tracking is disabled', async () => {
    const watched = new LazyWatch({ a: 1 });
    let inverseArg = 'not-set';
    LazyWatch.on(watched, (diff, inverse) => { inverseArg = inverse; });

    watched.a = 2;
    await wait(10);

    assertEquals(inverseArg, undefined, 'second listener arg should be undefined');
    LazyWatch.dispose(watched);
  });

  runner.test('applying the inverse should undo the batch (first write wins)', async () => {
    const watched = new LazyWatch({ count: 0, user: { name: 'Alice' } }, { inverse: true });
    const before = LazyWatch.snapshot(watched);
    let inv = null;
    LazyWatch.on(watched, (d, i) => { inv = i; });

    watched.count = 1;
    watched.count = 2;       // same key twice: inverse must keep the first pre-value
    watched.user.name = 'Bob';
    LazyWatch.flush(watched);

    assertEquals(inv, { count: 0, user: { name: 'Alice' } });
    LazyWatch.silent(watched, () => LazyWatch.patch(watched, inv));
    assertEquals(LazyWatch.snapshot(watched), before);
    LazyWatch.dispose(watched);
  });

  runner.test('nested listeners should receive path-relative inverses', async () => {
    const watched = new LazyWatch({ user: { name: 'a' }, other: 1 }, { inverse: true });
    let got = null;
    LazyWatch.on(watched.user, (diff, inverse) => { got = { diff, inverse }; });

    watched.user.name = 'b';
    await wait(10);

    assertEquals(got.diff, { name: 'b' });
    assertEquals(got.inverse, { name: 'a' });
    LazyWatch.dispose(watched);
  });

  runner.test('inverse should restore a container mutated, deleted, and recreated in one batch', async () => {
    const watched = new LazyWatch({ a: { x: 1, y: 2 } }, { inverse: true });
    let inv = null;
    LazyWatch.on(watched, (d, i) => { inv = i; });

    watched.a.x = 9;      // partial inverse fragment for a
    delete watched.a;     // gap-fill: y must be backfilled
    watched.a = { z: 5 }; // null-fill: z must be deleted on undo
    LazyWatch.flush(watched);

    LazyWatch.silent(watched, () => LazyWatch.patch(watched, inv));
    assertEquals(LazyWatch.snapshot(watched), { a: { x: 1, y: 2 } });
    LazyWatch.dispose(watched);
  });

  runner.test('inverse should restore wholesale array replacement with object elements', async () => {
    const watched = new LazyWatch({ items: [{ x: 1 }, { y: 2 }] }, { inverse: true });
    let inv = null;
    LazyWatch.on(watched, (d, i) => { inv = i; });

    watched.items = [{ z: 9 }];
    LazyWatch.flush(watched);

    LazyWatch.silent(watched, () => LazyWatch.patch(watched, inv));
    assertEquals(LazyWatch.snapshot(watched), { items: [{ x: 1 }, { y: 2 }] });
    LazyWatch.dispose(watched);
  });

  runner.test('inverse tracking should fall back from $splice and still undo structural ops', async () => {
    const watched = new LazyWatch({ items: [1, 2, 3, 4] }, { inverse: true });
    let got = null;
    LazyWatch.on(watched, (d, i) => { got = { diff: d, inverse: i }; });

    watched.items.splice(1, 2, 'x');
    LazyWatch.flush(watched);

    assertTrue(!got.diff.items.$splice, 'compact $splice must be disabled with inverse tracking');
    assertEquals(JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(watched.items))), [1, 'x', 4]);

    LazyWatch.silent(watched, () => LazyWatch.patch(watched, got.inverse));
    assertEquals(LazyWatch.snapshot(watched), { items: [1, 2, 3, 4] });
    LazyWatch.dispose(watched);
  });

  runner.test('inverse should restore array truncation', async () => {
    const watched = new LazyWatch({ items: ['a', 'b', 'c', 'd'] }, { inverse: true });
    let inv = null;
    LazyWatch.on(watched, (d, i) => { inv = i; });

    watched.items.length = 2;
    LazyWatch.flush(watched);

    LazyWatch.silent(watched, () => LazyWatch.patch(watched, inv));
    assertEquals(LazyWatch.snapshot(watched), { items: ['a', 'b', 'c', 'd'] });
    LazyWatch.dispose(watched);
  });

  runner.test('an inverse survives a JSON round-trip and undoes a synced mirror', async () => {
    const init = () => ({ list: [{ n: 1 }], flag: true });
    const src = new LazyWatch(init(), { inverse: true });
    const dst = new LazyWatch(init());
    let captured = null;
    LazyWatch.on(src, (diff, inverse) => {
      captured = { diff, inverse };
      LazyWatch.patch(dst, JSON.parse(JSON.stringify(diff)));
    });

    src.list.push({ n: 2 });
    src.flag = false;
    await wait(10);

    // Undo on the remote mirror using only the wire-serialized inverse
    LazyWatch.patch(dst, JSON.parse(JSON.stringify(captured.inverse)));
    await wait(10);
    assertEquals(LazyWatch.snapshot(dst), init());
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('transaction should apply and emit normally on success', async () => {
    const watched = new LazyWatch({ count: 1 });
    let diff = null;
    LazyWatch.on(watched, d => { diff = d; });

    const result = LazyWatch.transaction(watched, () => {
      watched.count = 2;
      return 'done';
    });

    assertEquals(result, 'done', 'transaction should return the callback result');
    await wait(10);
    assertEquals(diff, { count: 2 });
    LazyWatch.dispose(watched);
  });

  runner.test('transaction should roll back all changes and emit nothing when the callback throws', async () => {
    const watched = new LazyWatch({ user: { name: 'Alice', tags: ['a', 'b'] }, count: 1 });
    const before = LazyWatch.snapshot(watched);
    let calls = 0;
    LazyWatch.on(watched, () => { calls++; });

    assertThrows(() => LazyWatch.transaction(watched, () => {
      watched.count = 2;
      watched.user.name = 'Bob';
      watched.user.tags.push('c');
      watched.newTop = { x: 1 };
      delete watched.user.tags;
      throw new Error('boom');
    }));

    assertEquals(LazyWatch.snapshot(watched), before, 'state should be fully restored');
    await wait(10);
    assertEquals(calls, 0, 'nothing should emit after a rollback');
    LazyWatch.dispose(watched);
  });

  runner.test('transaction should flush pre-existing pending changes before starting', async () => {
    const watched = new LazyWatch({ count: 1 });
    const emitted = [];
    LazyWatch.on(watched, d => { emitted.push(d); });

    watched.count = 5; // pending when the transaction starts
    assertThrows(() => LazyWatch.transaction(watched, () => {
      watched.count = 6;
      throw new Error('boom');
    }));

    assertEquals(watched.count, 5, 'rollback should restore the flushed value, not the original');
    assertEquals(emitted, [{ count: 5 }], 'pre-transaction changes emit at the flush; the failed batch never does');
    await wait(10);
    assertEquals(emitted.length, 1);
    LazyWatch.dispose(watched);
  });

  runner.test('transactions cannot be nested', () => {
    const watched = new LazyWatch({ a: 1 });
    assertThrows(() => LazyWatch.transaction(watched, () => {
      LazyWatch.transaction(watched, () => {});
    }));
    assertEquals(watched.a, 1);
    LazyWatch.dispose(watched);
  });

  runner.test('a failed transaction should not disturb inverse tracking on inverse-enabled instances', async () => {
    const watched = new LazyWatch({ a: 1 }, { inverse: true });
    let got = null;
    LazyWatch.on(watched, (d, i) => { got = { diff: d, inverse: i }; });

    assertThrows(() => LazyWatch.transaction(watched, () => {
      watched.a = 99;
      throw new Error('boom');
    }));

    watched.a = 2; // normal batch afterwards: inverse must be clean
    await wait(10);
    assertEquals(got.diff, { a: 2 });
    assertEquals(got.inverse, { a: 1 }, 'inverse should not contain leftovers from the rolled-back batch');
    LazyWatch.dispose(watched);
  });

  runner.test('inverse diffs should undo random mixed operations (fuzz)', async () => {
    const src = new LazyWatch({ items: [], meta: {} }, { inverse: true });
    let captured = null;
    LazyWatch.on(src, (diff, inverse) => { captured = { diff, inverse }; });

    let seed = 1234;
    const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;

    for (let round = 0; round < 40; round++) {
      const pre = LazyWatch.snapshot(src);
      captured = null;
      const opsThisRound = 1 + rnd(4);
      for (let i = 0; i < opsThisRound; i++) {
        const len = src.items.length;
        switch (rnd(10)) {
          case 0: src.items.push({ v: rnd(100) }); break;
          case 1: src.items.unshift({ v: rnd(100) }); break;
          case 2: if (len) src.items.shift(); break;
          case 3: if (len) src.items.splice(rnd(len), rnd(2) + 1); break;
          case 4: src.items.splice(rnd(len + 1), 0, { v: rnd(100) }); break;
          case 5: if (len) src.items[rnd(len)] = { v: rnd(100) }; break;
          case 6: if (len) { const el = src.items[rnd(len)]; if (el && typeof el === 'object') el.v = rnd(100); } break;
          case 7: src.meta['k' + rnd(5)] = { deep: { n: rnd(100) } }; break;
          case 8: delete src.meta['k' + rnd(5)]; break;
          case 9: if (len > 2) src.items.length = len - 2; break;
        }
      }
      LazyWatch.flush(src);
      if (!captured) continue; // the round's ops may have been no-ops
      const post = LazyWatch.snapshot(src);

      // The inverse must restore the pre-batch state...
      LazyWatch.silent(src, () => LazyWatch.patch(src, captured.inverse));
      assertEquals(LazyWatch.snapshot(src), pre, `round ${round}: inverse should restore the pre-state`);
      // ...and the forward diff must then reproduce the post-batch state
      LazyWatch.silent(src, () => LazyWatch.patch(src, captured.diff));
      assertEquals(LazyWatch.snapshot(src), post, `round ${round}: forward diff should reproduce the post-state`);
    }

    LazyWatch.dispose(src);
  });
}
