// arrays.test.js - Array diff revival, compact $splice ops, and reordering methods (sort/reverse/copyWithin)
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, assertThrows, assertConverged, wait } from '../helpers.js';

export default function register(runner) {
  // Array diff revival tests
  // Array mutations are emitted as index-keyed fragments like { 1: 'b', length: 2 }.
  // Applied where the target already has the array they merge fine, but applied
  // where the field is missing they used to be stored verbatim as plain objects.

  runner.test('patch should revive an array diff when the target lacks the field', () => {
    const watched = new LazyWatch({});

    LazyWatch.patch(watched, { items: { 0: 'a', 1: 'b', length: 2 } });

    assertTrue(Array.isArray(LazyWatch.resolveIfProxy(watched.items)), 'items should be a real array');
    assertEquals(watched.items.length, 2, 'length should come from the fragment');
    assertEquals(watched.items[1], 'b');
    LazyWatch.dispose(watched);
  });

  runner.test('patch should revive array diffs nested inside a missing subtree', () => {
    const watched = new LazyWatch({});

    // A task created remotely, carrying its own index-keyed subtasks fragment.
    LazyWatch.patch(watched, {
      tasks: { 0: { title: 'x', subtasks: { 0: { done: false }, length: 1 } }, length: 1 },
    });

    assertTrue(Array.isArray(LazyWatch.resolveIfProxy(watched.tasks)), 'tasks should be an array');
    assertTrue(
      Array.isArray(LazyWatch.resolveIfProxy(watched.tasks[0].subtasks)),
      'nested subtasks should be an array'
    );
    assertEquals(watched.tasks[0].subtasks[0].done, false);
    LazyWatch.dispose(watched);
  });

  runner.test('patch should still merge array diffs into existing arrays', () => {
    const watched = new LazyWatch({ items: ['a', 'b', 'c'] });

    LazyWatch.patch(watched, { items: { 1: 'B', length: 3 } });

    assertTrue(Array.isArray(LazyWatch.resolveIfProxy(watched.items)), 'items should stay an array');
    assertEquals(LazyWatch.resolveIfProxy(watched.items), ['a', 'B', 'c']);
    LazyWatch.dispose(watched);
  });

  runner.test('patch should leave genuine objects alone when the target has one', () => {
    // Target shape wins: an existing plain object is merged into, not converted.
    const watched = new LazyWatch({ weird: { 0: 'x', length: 5 } });

    LazyWatch.patch(watched, { weird: { 1: 'z', length: 5 } });

    const weird = LazyWatch.resolveIfProxy(watched.weird);
    assertTrue(!Array.isArray(weird), 'existing object should not become an array');
    assertEquals(weird, { 0: 'x', 1: 'z', length: 5 });
    LazyWatch.dispose(watched);
  });

  runner.test('patch should not convert plain data that merely has a length property', () => {
    const watched = new LazyWatch({});

    LazyWatch.patch(watched, { dimensions: { length: 5 } });

    const dimensions = LazyWatch.resolveIfProxy(watched.dimensions);
    assertTrue(!Array.isArray(dimensions), '{ length: 5 } alone is data, not an array diff');
    assertEquals(dimensions, { length: 5 });
    LazyWatch.dispose(watched);
  });

  runner.test('patch on a plain object should revive array diffs when the target lacks the field', () => {
    const target = { existing: true };

    LazyWatch.patch(target, { items: { 0: 'a', length: 1 }, existing: false });

    assertTrue(Array.isArray(target.items), 'items should be a real array');
    assertEquals(target.items, ['a']);
    assertEquals(target.existing, false);
  });

  runner.test('replicas with shape drift should converge to identical arrays', async () => {
    // The receiver never got the diff that introduced `assignees` — the exact
    // drift that used to persist an { 0: ..., length: 1 } object downstream.
    const sender = new LazyWatch({ tasks: [{ id: 1, assignees: [] }] });
    const receiver = new LazyWatch({ tasks: [{ id: 1 }] });

    let emitted = null;
    LazyWatch.on(sender, diff => {
      emitted = diff;
    });

    sender.tasks[0].assignees.push('u-1');
    await wait(50);

    assertTrue(emitted !== null, 'sender should emit a diff');
    LazyWatch.patch(receiver, emitted);

    const received = LazyWatch.resolveIfProxy(receiver.tasks[0].assignees);
    assertTrue(Array.isArray(received), 'receiver should end up with a real array');
    assertEquals(received, ['u-1']);
    assertEquals(
      JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(receiver))),
      JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(sender))),
      'replicas should converge'
    );

    LazyWatch.dispose(sender);
    LazyWatch.dispose(receiver);
  });

  runner.test('overwrite should revive array diffs when the target lacks the field', () => {
    const watched = new LazyWatch({ keep: 1 });

    LazyWatch.overwrite(watched, { keep: 1, items: { 0: 'a', length: 1 } });

    assertTrue(Array.isArray(LazyWatch.resolveIfProxy(watched.items)), 'items should be a real array');
    assertEquals(watched.items[0], 'a');
    LazyWatch.dispose(watched);
  });

  // --- Compact $splice array ops ---

  runner.test('unshift should emit a compact $splice op', async () => {
    const watched = new LazyWatch({ items: Array.from({ length: 100 }, (_, i) => i) });
    let diff = null;
    LazyWatch.on(watched, d => { diff = d; });

    watched.items.unshift(-1);
    await wait(10);

    assertEquals(Object.keys(diff.items).sort(), ['$splice', 'length'], 'diff should only contain $splice and length');
    assertEquals(diff.items.$splice, [[0, 0, [-1]]]);
    assertEquals(diff.items.length, 101);
    assertEquals(watched.items[0], -1);
    assertEquals(watched.items.length, 101);
    LazyWatch.dispose(watched);
  });

  runner.test('shift and splice should emit compact ops with correct return values', async () => {
    const watched = new LazyWatch({ items: ['a', 'b', 'c', 'd'] });
    let diff = null;
    LazyWatch.on(watched, d => { diff = d; });

    const shifted = watched.items.shift();
    await wait(10);
    assertEquals(shifted, 'a', 'shift should return the removed element');
    assertEquals(diff.items.$splice, [[0, 1, []]]);
    assertEquals(diff.items.length, 3);

    const removed = watched.items.splice(1, 2, 'X');
    await wait(10);
    assertEquals(JSON.parse(JSON.stringify(removed)), ['c', 'd'], 'splice should return removed elements');
    assertEquals(diff.items.$splice, [[1, 2, ['X']]]);
    assertEquals(JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(watched.items))), ['b', 'X']);
    LazyWatch.dispose(watched);
  });

  runner.test('negative splice indices should be normalized in the op', async () => {
    const watched = new LazyWatch({ items: [1, 2, 3, 4] });
    let diff = null;
    LazyWatch.on(watched, d => { diff = d; });

    watched.items.splice(-1, 1); // remove last
    await wait(10);
    assertEquals(diff.items.$splice, [[3, 1, []]]);
    assertEquals(JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(watched.items))), [1, 2, 3]);
    LazyWatch.dispose(watched);
  });

  runner.test('$splice diffs should converge a patched mirror', async () => {
    const init = () => ({ items: [{ id: 0 }, { id: 1 }, { id: 2 }] });
    const src = new LazyWatch(init());
    const dst = new LazyWatch(init());
    LazyWatch.on(src, d => LazyWatch.patch(dst, d));

    src.items.unshift({ id: -1 });
    await wait(10);
    assertConverged(src, dst, 'after unshift');

    src.items.splice(2, 1, { id: 'x' }, { id: 'y' });
    await wait(10);
    assertConverged(src, dst, 'after splice replace');

    src.items.shift();
    await wait(10);
    assertConverged(src, dst, 'after shift');

    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('consecutive ops in one batch should append to $splice and converge', async () => {
    const init = () => ({ items: [1, 2, 3] });
    const src = new LazyWatch(init());
    const dst = new LazyWatch(init());
    let diff = null;
    LazyWatch.on(src, d => { diff = d; LazyWatch.patch(dst, d); });

    src.items.unshift(0);
    src.items.unshift(-1);
    src.items.shift();
    await wait(10);

    assertEquals(diff.items.$splice, [[0, 0, [0]], [0, 0, [-1]], [0, 1, []]]);
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('op followed by index and nested writes in one batch should converge', async () => {
    const init = () => ({ items: [{ id: 0 }, { id: 1 }] });
    const src = new LazyWatch(init());
    const dst = new LazyWatch(init());
    let diff = null;
    LazyWatch.on(src, d => { diff = d; LazyWatch.patch(dst, d); });

    src.items.unshift({ id: -1 });
    src.items[2] = { id: 'replaced' };   // post-op index
    src.items[0].id = 'mutated';         // post-op nested write
    await wait(10);

    assertTrue(Array.isArray(diff.items.$splice), 'op should still be compact');
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('index write before an op in one batch should fall back but converge', async () => {
    const init = () => ({ items: [1, 2, 3] });
    const src = new LazyWatch(init());
    const dst = new LazyWatch(init());
    let diff = null;
    LazyWatch.on(src, d => { diff = d; LazyWatch.patch(dst, d); });

    src.items[1] = 'changed'; // dirty node before the op
    src.items.unshift(0);
    await wait(10);

    assertTrue(!diff.items.$splice, 'op should fall back to per-index recording');
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('a relaying mirror should re-emit $splice compactly', async () => {
    const init = () => ({ items: [1, 2, 3] });
    const src = new LazyWatch(init());
    const mid = new LazyWatch(init());
    const relayed = [];
    LazyWatch.on(src, d => LazyWatch.patch(mid, d));
    LazyWatch.on(mid, d => relayed.push(d));

    src.items.unshift(0);
    await wait(20);

    assertTrue(relayed.length > 0, 'mirror should re-emit');
    assertTrue(relayed.some(d => d.items && Array.isArray(d.items.$splice)),
      'relayed diff should be compact');
    LazyWatch.dispose(src);
    LazyWatch.dispose(mid);
  });

  runner.test('patch should apply $splice ops to plain objects', () => {
    const plain = { items: ['a', 'b', 'c'] };
    LazyWatch.patch(plain, { items: { $splice: [[1, 1, ['X', 'Y']]], length: 4 } });
    assertEquals(plain.items, ['a', 'X', 'Y', 'c']);
  });

  runner.test('$splice fragments should revive into arrays when the target lacks the field', () => {
    const watched = new LazyWatch({});
    LazyWatch.patch(watched, { items: { $splice: [[0, 0, ['a', 'b']]], length: 2 } });
    assertTrue(Array.isArray(LazyWatch.resolveIfProxy(watched.items)), 'items should be a real array');
    assertEquals(JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(watched.items))), ['a', 'b']);
    LazyWatch.dispose(watched);
  });

  runner.test('structural ops should reject collection items before mutating', () => {
    const watched = new LazyWatch({ items: [1, 2, 3] });
    assertThrows(() => watched.items.unshift(new Map()));
    assertThrows(() => watched.items.splice(1, 0, { deep: new Set() }));
    assertEquals(JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(watched.items))), [1, 2, 3],
      'state should be untouched after rejection');
    LazyWatch.dispose(watched);
  });

  runner.test('no-op structural calls should not emit', async () => {
    const watched = new LazyWatch({ items: [1, 2, 3] });
    let called = false;
    LazyWatch.on(watched, () => { called = true; });

    watched.items.splice(1, 0);   // no delete, no insert
    watched.items.splice(0, 0);   // no delete, no insert at head
    await wait(10);

    assertEquals(called, false, 'no-op splice should not emit');
    assertEquals(JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(watched.items))), [1, 2, 3]);
    LazyWatch.dispose(watched);
  });

  runner.test('random mixed array operations should converge (fuzz)', async () => {
    const init = () => ({ items: [] });
    const src = new LazyWatch(init());
    const dst = new LazyWatch(init());
    LazyWatch.on(src, d => LazyWatch.patch(dst, d));

    let seed = 42;
    const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;

    for (let round = 0; round < 30; round++) {
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
          case 7: if (len > 1) src.items.sort((a, b) => a.v - b.v); break;
          case 8: if (len > 1) src.items.reverse(); break;
          case 9: if (len > 1) src.items.copyWithin(rnd(len), rnd(len)); break;
        }
      }
      await wait(5); // emit + patch between rounds
      assertConverged(src, dst, `round ${round}`);
    }

    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  // --- Reordering array methods (sort/reverse/copyWithin corruption fix) ---
  // Run natively through the proxy, these methods' read-all/write-back
  // pattern corrupted object elements: slot-merge mutated the raw object at
  // a written slot while it was still the pending source for a later slot.

  runner.test('sort should not corrupt arrays of objects and should converge a mirror', async () => {
    const init = () => ({ items: [{ n: 3 }, { n: 1 }, { n: 2 }] });
    const src = new LazyWatch(init());
    const dst = new LazyWatch(init());
    LazyWatch.on(src, d => LazyWatch.patch(dst, d));

    const result = src.items.sort((a, b) => a.n - b.n);
    assertEquals(LazyWatch.snapshot(src).items, [{ n: 1 }, { n: 2 }, { n: 3 }],
      'sorted state should keep every element intact');
    assertTrue(result === src.items, 'sort should return the array proxy');

    await wait(5);
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('reverse should not corrupt arrays of objects and should converge a mirror', async () => {
    const init = () => ({ items: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] });
    const src = new LazyWatch(init());
    const dst = new LazyWatch(init());
    LazyWatch.on(src, d => LazyWatch.patch(dst, d));

    src.items.reverse();
    assertEquals(LazyWatch.snapshot(src).items, [{ n: 4 }, { n: 3 }, { n: 2 }, { n: 1 }],
      'reversed state should keep every element intact');

    await wait(5);
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('copyWithin should not corrupt overlapping object ranges', async () => {
    const init = () => ({ items: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] });
    const src = new LazyWatch(init());
    const dst = new LazyWatch(init());
    LazyWatch.on(src, d => LazyWatch.patch(dst, d));

    src.items.copyWithin(1, 0, 3); // overlapping shift-up: the corrupting direction
    assertEquals(LazyWatch.snapshot(src).items, [{ n: 1 }, { n: 1 }, { n: 2 }, { n: 3 }]);

    await wait(5);
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('sort of primitives should still work and emit once', async () => {
    const src = new LazyWatch({ items: [3, 1, 2] });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.items.sort((a, b) => a - b);
    await wait(5);
    assertEquals(LazyWatch.snapshot(src).items, [1, 2, 3]);
    assertEquals(diffs.length, 1, 'one batch');
    LazyWatch.dispose(src);
  });

  runner.test('sorting an already-sorted array should not emit', async () => {
    const src = new LazyWatch({ items: [{ n: 1 }, { n: 2 }] });
    let emits = 0;
    LazyWatch.on(src, () => emits++);

    src.items.sort((a, b) => a.n - b.n);
    await wait(5);
    assertEquals(emits, 0, 'no relocated slots, nothing to emit');
    LazyWatch.dispose(src);
  });

  runner.test('a throwing sort comparator should leave state untouched and emit nothing', async () => {
    const src = new LazyWatch({ items: [{ n: 2 }, { n: 1 }] });
    let emits = 0;
    LazyWatch.on(src, () => emits++);

    assertThrows(() => src.items.sort(() => { throw new Error('boom'); }));
    assertEquals(LazyWatch.snapshot(src).items, [{ n: 2 }, { n: 1 }]);
    await wait(5);
    assertEquals(emits, 0);
    LazyWatch.dispose(src);
  });

  runner.test('inverse should undo a sort', async () => {
    const src = new LazyWatch({ items: [{ n: 3 }, { n: 1 }, { n: 2 }] }, { inverse: true });
    let inv;
    LazyWatch.on(src, (d, i) => { inv = i; });

    src.items.sort((a, b) => a.n - b.n);
    await wait(5);
    assertEquals(LazyWatch.snapshot(src).items, [{ n: 1 }, { n: 2 }, { n: 3 }]);

    LazyWatch.patch(src, inv);
    await wait(5);
    assertEquals(LazyWatch.snapshot(src).items, [{ n: 3 }, { n: 1 }, { n: 2 }],
      'inverse should restore the pre-sort order');
    LazyWatch.dispose(src);
  });
}
