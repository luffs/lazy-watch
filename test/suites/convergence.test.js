// convergence.test.js - Destroy-and-recreate convergence (stale-key null-fill on the wire)
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertObjectEqual, wait } from '../helpers.js';

export default function register(runner) {
  // Destroy-and-recreate convergence tests

  // Sync a patch-based mirror and assert it converges after the callback's
  // changes have emitted
  async function assertMirrorConverges(initial, mutate, message) {
    const src = new LazyWatch(LazyWatch.Utils.deepClone(initial));
    const mirror = new LazyWatch(LazyWatch.Utils.deepClone(initial));
    LazyWatch.on(src, d => LazyWatch.patch(mirror, d));
    mutate(src);
    await wait(10);
    assertEquals(LazyWatch.snapshot(mirror), LazyWatch.snapshot(src), message);
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  }

  runner.test('one-batch delete and recreate should converge patch mirrors', async () => {
    const src = new LazyWatch({ k: { a: 1 } });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    delete src.k;
    src.k = { b: 2 };
    await wait(10);

    assertObjectEqual(diffs[0], { k: { b: 2, a: null } },
      'the recreation diff should null-fill the stale key');
    assertEquals(LazyWatch.snapshot(src), { k: { b: 2 } },
      'the null marker must never enter local state');
    LazyWatch.dispose(src);

    await assertMirrorConverges({ k: { a: 1 } }, w => {
      delete w.k;
      w.k = { b: 2 };
    }, 'delete-then-recreate in one batch should converge');
  });

  runner.test('one-batch leaf overwrite and recreate should converge', async () => {
    await assertMirrorConverges({ k: { a: 1 } }, w => {
      w.k = 5;
      w.k = { b: 2 };
    }, 'container -> leaf -> container in one batch should converge');

    await assertMirrorConverges({ k: { a: 1 } }, w => {
      w.k = undefined; // normalized to a deletion
      w.k = { b: 2 };
    }, 'undefined-assignment deletion then recreation should converge');
  });

  runner.test('API-level deletion and recreation in one batch should converge', async () => {
    await assertMirrorConverges({ k: { a: 1 } }, w => {
      LazyWatch.patch(w, { k: null });
      LazyWatch.patch(w, { k: { b: 2 } });
    }, 'patch-delete then patch-recreate in one batch should converge');
  });

  runner.test('nested stale keys should be null-filled recursively', async () => {
    await assertMirrorConverges({ k: { a: { y: 9 }, keep: 1 } }, w => {
      delete w.k;
      w.k = { a: { x: 1 } };
    }, 'shared nested containers must null-fill their own stale keys');
  });

  runner.test('array truncation then recreation should converge', async () => {
    await assertMirrorConverges({ arr: [{ a: 1 }, { a: 2 }] }, w => {
      w.arr.length = 0;
      w.arr.push({ b: 9 });
    }, 'truncate-then-push in one batch should converge');
  });

  runner.test('wholesale array replacement with object elements should converge', async () => {
    await assertMirrorConverges({ list: [{ a: 1 }, { a: 2 }] }, w => {
      w.list = [{ b: 9 }];
    }, 'real arrays in diffs are wholesale values, not merge fragments');

    // ...and through a relay chain: the intermediate mirror re-emits the
    // full array, so the far mirror converges too
    const a = new LazyWatch({ list: [{ a: 1 }] });
    const b = new LazyWatch({ list: [{ a: 1 }] });
    const c = new LazyWatch({ list: [{ a: 1 }] });
    LazyWatch.on(a, d => LazyWatch.patch(b, d));
    LazyWatch.on(b, d => LazyWatch.patch(c, d));

    a.list = [{ z: 5 }];
    await wait(10);
    assertEquals(LazyWatch.snapshot(c), { list: [{ z: 5 }] }, 'the far mirror should converge');
    LazyWatch.dispose(a);
    LazyWatch.dispose(b);
    LazyWatch.dispose(c);
  });

  runner.test('re-applying an already-applied wholesale array should not emit', async () => {
    const watched = new LazyWatch({ list: [{ a: 1 }] });
    let emits = 0;
    LazyWatch.on(watched, () => { emits++; });

    LazyWatch.patch(watched, { list: [{ a: 1 }] });
    await wait(10);
    assertEquals(emits, 0, 'a no-op wholesale replacement must stay silent (echo stability)');
    LazyWatch.dispose(watched);
  });

  runner.test('patch should not mutate or alias the source diff', async () => {
    // A diff applied to one mirror must stay intact for the next one
    const m1 = new LazyWatch({});                    // lacks k: wholesale-set path
    const m2 = new LazyWatch({ k: { a: 1, b: 1 } }); // has k: merge path
    const diff = { k: { a: null, c: 2 } };
    const before = JSON.stringify(diff);

    LazyWatch.patch(m1, diff);
    assertEquals(JSON.stringify(diff), before, 'patch must not mutate its source');
    LazyWatch.patch(m2, diff);
    assertEquals(LazyWatch.snapshot(m2), { k: { b: 1, c: 2 } },
      'the second mirror should still see the deletion');
    LazyWatch.dispose(m1);
    LazyWatch.dispose(m2);
  });

  runner.test('null markers inside wholesale-set values should be stripped, not stored', () => {
    const target = {};
    LazyWatch.patch(target, { k: { n: { x: null }, keep: 1 } });
    assertEquals(target, { k: { n: {}, keep: 1 } },
      'nulls mean delete and must never become literal state');

    const watched = new LazyWatch({});
    LazyWatch.patch(watched, { k: { n: { x: null }, keep: 1 } });
    assertEquals(LazyWatch.snapshot(watched), { k: { n: {}, keep: 1 } });
    LazyWatch.dispose(watched);
  });

  runner.test('destroy-and-recreate patterns should converge (fuzz)', async () => {
    const src = new LazyWatch({ obj: {}, arr: [] });
    const mirror = new LazyWatch({ obj: {}, arr: [] });
    LazyWatch.on(src, d => LazyWatch.patch(mirror, d));

    let seed = 777;
    const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const mk = () => {
      const o = { v: rnd(100) };
      if (rnd(2)) o.nested = { deep: rnd(100) };
      return o;
    };

    for (let round = 0; round < 50; round++) {
      const opsThisRound = 1 + rnd(4);
      for (let i = 0; i < opsThisRound; i++) {
        const key = 'k' + rnd(4);
        switch (rnd(8)) {
          case 0: src.obj[key] = mk(); break;
          case 1: delete src.obj[key]; break;
          case 2: src.obj[key] = rnd(2) ? 'leaf' : rnd(100); break;
          case 3: src.arr = Array.from({ length: rnd(4) }, mk); break; // wholesale
          case 4: if (src.arr.length) src.arr[rnd(src.arr.length)] = mk(); break;
          case 5: src.arr.length = rnd(src.arr.length + 1); break;
          case 6: src.arr.push(mk()); break;
          case 7: src.obj[key] = mk(); delete src.obj[key]; src.obj[key] = mk(); break;
        }
      }
      LazyWatch.flush(src);
      assertEquals(LazyWatch.snapshot(mirror), LazyWatch.snapshot(src),
        `round ${round}: mirror should converge`);
    }
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });
}
