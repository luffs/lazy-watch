// origin.test.js - Batch metadata: flush(watched, meta), patch/overwrite with a
// third argument, listeners' third parameter, and undo/redo origins
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, assertThrows, assertConverged, wait } from '../helpers.js';

export default function register(runner) {
  runner.test('flush with metadata should hand it to every listener as the third argument', async () => {
    const watched = new LazyWatch({ user: { name: 'a' }, n: 0 });
    const log = [];
    LazyWatch.on(watched, (d, inv, meta) => log.push(['root', d, meta]));
    LazyWatch.on(watched.user, (d, inv, meta) => log.push(['user', d, meta]));

    watched.user.name = 'b';
    LazyWatch.flush(watched, { origin: 'autosave', seq: 7 });
    assertEquals(log, [
      ['root', { user: { name: 'b' } }, { origin: 'autosave', seq: 7 }],
      ['user', { name: 'b' }, { origin: 'autosave', seq: 7 }]
    ]);

    // An ordinary microtask batch carries no metadata
    log.length = 0;
    watched.n = 1;
    await wait(5);
    assertEquals(log, [['root', { n: 1 }, undefined]]);
    assertTrue(log[0][2] === undefined, 'meta must be undefined, not null');
    LazyWatch.dispose(watched);
  });

  runner.test('patch with metadata should emit pending changes first, then the applied changes tagged', async () => {
    const watched = new LazyWatch({ count: 0, name: '' });
    const log = [];
    LazyWatch.on(watched, (d, inv, meta) => log.push([d, meta]));

    watched.count = 1; // still batched
    LazyWatch.patch(watched, { name: 'x' }, { origin: 'remote' });
    assertEquals(log, [[{ count: 1 }, undefined], [{ name: 'x' }, { origin: 'remote' }]],
      'the local change must not ride in the tagged batch');
    await wait(5);
    assertEquals(log.length, 2, 'nothing left pending');
    LazyWatch.dispose(watched);
  });

  runner.test('overwrite, nested proxies, and the deprecated aliases should accept metadata', () => {
    const watched = new LazyWatch({ a: { x: 1, y: 2 }, b: 1 });
    const log = [];
    LazyWatch.on(watched, (d, inv, meta) => log.push([d, meta]));

    LazyWatch.overwrite(watched.a, { x: 5 }, { origin: 'snapshot' });
    LazyWatch.patchObject(watched, { b: 2 }, { origin: 'p' });
    LazyWatch.overwriteObject(watched, { a: { x: 5 }, b: 3 }, { origin: 'o' });
    assertEquals(log, [
      [{ a: { x: 5, y: null } }, { origin: 'snapshot' }],
      [{ b: 2 }, { origin: 'p' }],
      [{ b: 3 }, { origin: 'o' }]
    ]);
    LazyWatch.dispose(watched);
  });

  runner.test('patch with metadata should emit nothing when it changes nothing', async () => {
    const watched = new LazyWatch({ a: 1 });
    let calls = 0;
    LazyWatch.on(watched, () => calls++);
    LazyWatch.patch(watched, { a: 1 }, { origin: 'remote' }); // echo of an applied diff
    await wait(5);
    assertEquals(calls, 0);
    LazyWatch.dispose(watched);
  });

  runner.test('metadata should be ignored on plain targets and rejected when not an object', () => {
    const plain = { a: 1 };
    LazyWatch.patch(plain, { b: 2 }, { origin: 'remote' });
    assertEquals(plain, { a: 1, b: 2 });

    const watched = new LazyWatch({ a: 1 });
    assertThrows(() => LazyWatch.flush(watched, 'remote'));
    assertThrows(() => LazyWatch.flush(watched, null));
    assertThrows(() => LazyWatch.patch(watched, { a: 2 }, 'remote'));
    assertEquals(watched.a, 1, 'a rejected call must not apply');
    LazyWatch.dispose(watched);
  });

  runner.test('a bidirectional sync built on origins should converge without echoing', async () => {
    const a = new LazyWatch({ n: 0, list: [1] });
    const b = new LazyWatch({ n: 0, list: [1] });
    let sent = 0;
    const link = (from, to) => LazyWatch.on(from, (diff, inverse, meta) => {
      if (meta?.origin === 'remote') return;
      sent++;
      LazyWatch.patch(to, JSON.parse(JSON.stringify(diff)), { origin: 'remote' });
    });
    link(a, b);
    link(b, a);

    a.n = 1;
    a.list.push(2);
    await wait(5);
    b.n = 2;
    b.list.unshift(0);
    await wait(5);
    a.list = { replaced: true };
    await wait(5);

    assertConverged(a, b);
    assertEquals(LazyWatch.snapshot(a), { n: 2, list: { replaced: true } });
    assertEquals(sent, 3, 'one message per local batch, none echoed back');
    LazyWatch.dispose(a);
    LazyWatch.dispose(b);
  });

  runner.test('undo and redo batches should carry an origin', async () => {
    const watched = new LazyWatch({ n: 0 });
    const manager = LazyWatch.createUndoManager(watched);
    const log = [];
    LazyWatch.on(watched, (d, inv, meta) => log.push([d, meta]));

    watched.n = 1;
    await wait(5);
    manager.undo();
    manager.redo();
    assertEquals(log, [
      [{ n: 1 }, undefined],
      [{ n: 0 }, { origin: 'undo' }],
      [{ n: 1 }, { origin: 'redo' }]
    ]);
    // A step grouped or coalesced still emits its replay as one tagged batch
    manager.group(() => { watched.n = 2; LazyWatch.flush(watched); watched.n = 3; });
    log.length = 0;
    manager.undo();
    assertEquals(log, [[{ n: 1 }, { origin: 'undo' }]]);
    LazyWatch.dispose(watched);
  });

  runner.test('a transaction should not tag its batch, and flush inside patch metadata should not leak', async () => {
    const watched = new LazyWatch({ n: 0 });
    const log = [];
    LazyWatch.on(watched, (d, inv, meta) => log.push(meta));
    LazyWatch.transaction(watched, () => { watched.n = 1; });
    await wait(5);
    LazyWatch.patch(watched, { n: 2 }, { origin: 'remote' });
    watched.n = 3;
    await wait(5);
    assertEquals(log, [undefined, { origin: 'remote' }, undefined]);
    LazyWatch.dispose(watched);
  });
}
