// plain-targets.test.js - patch/overwrite on normal (non-proxy) objects
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, assertThrows, wait } from '../helpers.js';

export default function register(runner) {
  // --- patch/overwrite on normal (non-proxy) objects ---

  runner.test('overwrite on a plain object should delete properties missing from the source', () => {
    const target = { a: 1, b: 2, c: 3 };
    LazyWatch.overwrite(target, { a: 10, d: 4 });
    assertEquals(target, { a: 10, d: 4 }, 'b and c should be deleted');
  });

  runner.test('overwrite on a plain object should delete missing keys recursively in nested objects', () => {
    const target = { keep: 1, nested: { d: 3, e: 4, deep: { x: 1, y: 2 } } };
    LazyWatch.overwrite(target, { keep: 1, nested: { d: 30, deep: { x: 9 } } });
    assertEquals(target, { keep: 1, nested: { d: 30, deep: { x: 9 } } },
      'e and deep.y should be deleted');
  });

  runner.test('overwrite on a plain object should replace arrays wholesale and adopt their length', () => {
    const target = { items: [{ n: 1 }, { n: 2 }, { n: 3 }], obj: { a: 1 } };
    LazyWatch.overwrite(target, { items: [{ z: 9 }], obj: { a: 1 } });
    assertEquals(target.items, [{ z: 9 }], 'source array is a wholesale value');
    assertEquals(target.items.length, 1, 'tail truncated');
  });

  runner.test('overwrite on a plain object should apply $splice fragments without trimming array keys', () => {
    const target = { items: ['b', 'c'] };
    LazyWatch.overwrite(target, { items: { $splice: [[0, 0, ['a']]], length: 3 } });
    assertEquals(target.items, ['a', 'b', 'c'], 'ops applied; elements not deleted for being missing');
  });

  runner.test('overwrite on a plain object should apply an authoritative snapshot over a drifted mirror', async () => {
    // The reconnect-resync use case: a plain mirror (e.g. a Vue reactive
    // object) that drifted while disconnected must exactly match the snapshot
    const server = new LazyWatch({ user: { name: 'Alice' }, todos: [{ id: 1 }] });
    const mirror = LazyWatch.snapshot(server);

    // Offline drift on both sides
    mirror.stale = { junk: true };
    mirror.user.staleNested = 'x';
    server.user.name = 'Bob';
    delete server.todos[0].id;
    await wait(5);

    LazyWatch.overwrite(mirror, LazyWatch.snapshot(server));
    assertEquals(mirror, LazyWatch.snapshot(server), 'mirror matches the snapshot exactly');
    assertTrue(!('stale' in mirror) && !('staleNested' in mirror.user), 'drift deleted');
    LazyWatch.dispose(server);
  });

  runner.test('overwrite on a plain object should validate the source and leave the target untouched on rejection', () => {
    const target = { a: 1 };
    assertThrows(() => LazyWatch.overwrite(target, { bad: new Map() }));
    assertThrows(() => LazyWatch.overwrite(target, JSON.parse('{"__proto__": {"polluted": true}}')));
    assertEquals({}.polluted, undefined, 'Object.prototype must not be polluted');
    assertEquals(target, { a: 1 }, 'target untouched after rejection');
  });

  runner.test('overwrite on a plain object should not mutate or alias the source', () => {
    const source = { c: { d: 1 }, list: [{ n: 1 }] };
    const target = { old: true };
    LazyWatch.overwrite(target, source);
    assertEquals(source, { c: { d: 1 }, list: [{ n: 1 }] }, 'source unchanged');
    target.c.d = 99;
    target.list[0].n = 99;
    assertEquals(source.c.d, 1, 'nested objects are cloned, not aliased');
    assertEquals(source.list[0].n, 1, 'array elements are cloned, not aliased');
  });

  runner.test('patch on a plain object should keep merge semantics (regression)', () => {
    const target = { a: 1, b: 2 };
    LazyWatch.patch(target, { a: 10 });
    assertEquals(target, { a: 10, b: 2 }, 'plain patch must not delete missing keys');
  });

  runner.test('plain-object targets should not record or emit anything', async () => {
    // A plain object next to a live instance: applying to it must not leak
    // into any instance's diff stream
    const watched = new LazyWatch({ a: 1 });
    let emits = 0;
    LazyWatch.on(watched, () => emits++);

    const plain = { a: 1 };
    LazyWatch.patch(plain, { a: 2 });
    LazyWatch.overwrite(plain, { b: 3 });
    await wait(5);
    assertEquals(plain, { b: 3 });
    assertEquals(emits, 0, 'no instance emitted');
    LazyWatch.dispose(watched);
  });

  runner.test('patch/overwrite on a disposed proxy should throw, not degrade to plain mode', async () => {
    const watched = new LazyWatch({ a: 1 });
    LazyWatch.dispose(watched);
    // Silently applying without emitting would mask bugs; it must stay loud
    assertThrows(() => LazyWatch.patch(watched, { a: 2 }));
    assertThrows(() => LazyWatch.overwrite(watched, { a: 2 }));
    assertEquals(LazyWatch.resolveIfProxy(watched).a, 1, 'state untouched');
  });

  runner.test('patch/overwrite should reject non-container targets with a clear error', () => {
    for (const bad of [null, undefined, 42, 'str', new Date(), new Map()]) {
      assertThrows(() => LazyWatch.patch(bad, { a: 1 }));
      assertThrows(() => LazyWatch.overwrite(bad, { a: 1 }));
    }
  });

  runner.test('patchObject and overwriteObject should remain as aliases of patch and overwrite', async () => {
    // Plain targets: identical applier semantics
    const plain = { a: 1, b: 2 };
    LazyWatch.patchObject(plain, { a: 10 });
    assertEquals(plain, { a: 10, b: 2 }, 'patchObject merges');
    LazyWatch.overwriteObject(plain, { c: 3 });
    assertEquals(plain, { c: 3 }, 'overwriteObject deletes missing keys');

    // Proxy targets: delegate to the tracked path, like the unified methods
    const watched = new LazyWatch({ a: 1 });
    const diffs = [];
    LazyWatch.on(watched, d => diffs.push(d));
    LazyWatch.patchObject(watched, { a: 2 });
    await wait(5);
    assertEquals(diffs, [{ a: 2 }], 'alias on a proxy records and emits');
    LazyWatch.dispose(watched);
  });

  runner.test('plain-object patch should truncate target arrays on wholesale array replacement', () => {
    // Regression: for-in never visits a real source array's non-enumerable
    // `length`, so shorter wholesale arrays left the target's tail behind —
    // desyncing plain-object receivers from proxy receivers
    const target = { list: [1, 2, 3, 4] };
    LazyWatch.patch(target, { list: [9, 8] });
    assertEquals(target, { list: [9, 8] }, 'a shorter source array should truncate the target');

    const nested = { a: { list: ['x', 'y', 'z'] } };
    LazyWatch.patch(nested, { a: { list: ['q'] } });
    assertEquals(nested, { a: { list: ['q'] } }, 'truncation should apply at nested levels too');
  });
}
