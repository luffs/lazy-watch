// nested-patch.test.js - patch/overwrite entering at a nested proxy (path-correct diffs and inverses)
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertThrows, assertConverged, wait } from '../helpers.js';

export default function register(runner) {
  // --- Nested-proxy patch/overwrite (wrong-path diff fix) ---
  // Previously the state updated correctly but the diff was recorded at the
  // root, so mirrors applied it to the wrong place and desynced.

  runner.test('patch on a nested proxy should emit the diff at the nested path', async () => {
    const init = () => ({ user: { name: 'Alice' }, count: 0 });
    const src = new LazyWatch(init());
    const dst = new LazyWatch(init());
    const diffs = [];
    LazyWatch.on(src, d => { diffs.push(d); LazyWatch.patch(dst, d); });

    LazyWatch.patch(src.user, { name: 'Bob' });
    await wait(5);
    assertEquals(diffs, [{ user: { name: 'Bob' } }], 'diff should be rooted at the subtree path');
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('overwrite on a nested proxy should delete missing keys at the nested path', async () => {
    const init = () => ({ user: { name: 'Alice', age: 30 }, count: 0 });
    const src = new LazyWatch(init());
    const dst = new LazyWatch(init());
    const diffs = [];
    LazyWatch.on(src, d => { diffs.push(d); LazyWatch.patch(dst, d); });

    LazyWatch.overwrite(src.user, { name: 'Bob' });
    await wait(5);
    assertEquals(LazyWatch.snapshot(src), { user: { name: 'Bob' }, count: 0 });
    assertEquals(diffs, [{ user: { name: 'Bob', age: null } }],
      'the deletion must live under the subtree, not at the root');
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('patch on a deeply nested proxy should converge a mirror', async () => {
    const init = () => ({ a: { b: { c: { v: 1 }, other: 1 } } });
    const src = new LazyWatch(init());
    const dst = new LazyWatch(init());
    LazyWatch.on(src, d => LazyWatch.patch(dst, d));

    LazyWatch.patch(src.a.b, { c: { v: 2 } });
    await wait(5);
    assertEquals(LazyWatch.snapshot(src).a.b, { c: { v: 2 }, other: 1 });
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('a nested listener should receive a path-relative diff from a nested patch', async () => {
    const src = new LazyWatch({ user: { name: 'Alice' } });
    const seen = [];
    LazyWatch.on(src.user, d => seen.push(d));

    LazyWatch.patch(src.user, { name: 'Bob' });
    await wait(5);
    assertEquals(seen, [{ name: 'Bob' }]);
    LazyWatch.dispose(src);
  });

  runner.test('patch on a nested proxy should still validate and reject unsupported values', () => {
    const src = new LazyWatch({ user: { name: 'A' } });
    assertThrows(() => LazyWatch.patch(src.user, { bad: new Map() }));
    assertThrows(() => LazyWatch.patch(src.user, JSON.parse('{"__proto__": {"polluted": true}}')));
    assertEquals({}.polluted, undefined, 'Object.prototype must not be polluted');
    assertEquals(LazyWatch.snapshot(src), { user: { name: 'A' } }, 'state untouched');
    LazyWatch.dispose(src);
  });

  runner.test('nested-proxy patch should record a path-correct inverse', async () => {
    const src = new LazyWatch({ user: { name: 'Alice' } }, { inverse: true });
    let inv;
    LazyWatch.on(src, (d, i) => { inv = i; });

    LazyWatch.patch(src.user, { name: 'Bob' });
    await wait(5);
    assertEquals(inv, { user: { name: 'Alice' } });

    LazyWatch.patch(src, inv);
    await wait(5);
    assertEquals(LazyWatch.snapshot(src), { user: { name: 'Alice' } });
    LazyWatch.dispose(src);
  });
}
