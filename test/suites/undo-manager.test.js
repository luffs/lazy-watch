// undo-manager.test.js - Undo/redo stacks, step grouping, and coalescing
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, assertThrows, assertConverged, wait } from '../helpers.js';

export default function register(runner) {
  // Undo manager tests
  runner.test('undo manager should undo and redo a batch', async () => {
    const watched = new LazyWatch({ count: 0, name: 'a' });
    const manager = LazyWatch.createUndoManager(watched);
    assertTrue(!manager.canUndo && !manager.canRedo, 'fresh manager should have no history');

    watched.count = 1;
    watched.name = 'b';
    await wait(10);

    assertTrue(manager.canUndo, 'a recorded batch should be undoable');
    assertTrue(manager.undo(), 'undo should report success');
    assertEquals(LazyWatch.snapshot(watched), { count: 0, name: 'a' });
    assertTrue(!manager.canUndo && manager.canRedo, 'after undo only redo should be available');

    assertTrue(manager.redo(), 'redo should report success');
    assertEquals(LazyWatch.snapshot(watched), { count: 1, name: 'b' });
    assertTrue(manager.canUndo && !manager.canRedo, 'after redo only undo should be available');
    LazyWatch.dispose(watched);
  });

  runner.test('undo manager should step through multiple batches in reverse order', async () => {
    const watched = new LazyWatch({ n: 0 });
    const manager = LazyWatch.createUndoManager(watched);

    watched.n = 1;
    await wait(10);
    watched.n = 2;
    await wait(10);
    watched.n = 3;
    await wait(10);

    manager.undo();
    assertEquals(watched.n, 2);
    manager.undo();
    assertEquals(watched.n, 1);
    manager.undo();
    assertEquals(watched.n, 0);
    assertTrue(!manager.canUndo, 'history should be exhausted');
    assertTrue(!manager.undo(), 'undo on empty history should return false');

    manager.redo();
    manager.redo();
    assertEquals(watched.n, 2);
    LazyWatch.dispose(watched);
  });

  runner.test('a new change should clear the redo stack', async () => {
    const watched = new LazyWatch({ n: 0 });
    const manager = LazyWatch.createUndoManager(watched);

    watched.n = 1;
    await wait(10);
    manager.undo();
    assertTrue(manager.canRedo);

    watched.n = 99;
    await wait(10);
    assertTrue(!manager.canRedo, 'a new change must invalidate redo history');
    assertTrue(!manager.redo(), 'redo after an intervening change should return false');
    assertEquals(watched.n, 99);
    LazyWatch.dispose(watched);
  });

  runner.test('undo manager should drop the oldest step beyond the limit', async () => {
    const watched = new LazyWatch({ n: 0 });
    const manager = LazyWatch.createUndoManager(watched, { limit: 2 });

    watched.n = 1;
    await wait(10);
    watched.n = 2;
    await wait(10);
    watched.n = 3;
    await wait(10);

    manager.undo();
    manager.undo();
    assertEquals(watched.n, 1, 'the oldest step (0 -> 1) should have been dropped');
    assertTrue(!manager.canUndo);
    LazyWatch.dispose(watched);
  });

  runner.test('undo should flush and undo pending changes immediately', async () => {
    const watched = new LazyWatch({ text: '' }, { debounce: 200 });
    const manager = LazyWatch.createUndoManager(watched);

    watched.text = 'hello';
    // No wait: the debounce timer has not fired, the change is still pending
    assertTrue(manager.canUndo, 'pending changes should count as undoable');
    assertTrue(manager.undo());
    assertEquals(watched.text, '', 'undo should cover the flushed pending batch');

    manager.redo();
    assertEquals(watched.text, 'hello');
    LazyWatch.dispose(watched);
  });

  runner.test('undo and redo should emit normal batches so mirrors stay in sync', async () => {
    const source = new LazyWatch({ list: [1, 2], meta: { ok: true } });
    const mirror = new LazyWatch({ list: [1, 2], meta: { ok: true } });
    const manager = LazyWatch.createUndoManager(source);
    LazyWatch.on(source, diff => LazyWatch.patch(mirror, diff));

    source.list.push(3);
    source.meta.ok = false;
    await wait(10);
    assertEquals(LazyWatch.snapshot(mirror), { list: [1, 2, 3], meta: { ok: false } });

    manager.undo();
    await wait(10);
    assertEquals(LazyWatch.snapshot(mirror), { list: [1, 2], meta: { ok: true } },
      'the mirror should follow the undo');

    manager.redo();
    await wait(10);
    assertEquals(LazyWatch.snapshot(mirror), { list: [1, 2, 3], meta: { ok: false } },
      'the mirror should follow the redo');
    LazyWatch.dispose(source);
    LazyWatch.dispose(mirror);
  });

  runner.test('undo manager should undo structural array ops', async () => {
    const watched = new LazyWatch({ items: ['a', 'b', 'c'] });
    const manager = LazyWatch.createUndoManager(watched);

    watched.items.splice(1, 1, 'x', 'y');
    watched.items.unshift('start');
    await wait(10);
    assertEquals(LazyWatch.snapshot(watched), { items: ['start', 'a', 'x', 'y', 'c'] });

    manager.undo();
    assertEquals(LazyWatch.snapshot(watched), { items: ['a', 'b', 'c'] });
    LazyWatch.dispose(watched);
  });

  runner.test('a successful transaction should form a single undo step', async () => {
    const watched = new LazyWatch({ balance: 500, history: [] });
    const manager = LazyWatch.createUndoManager(watched);

    LazyWatch.transaction(watched, () => {
      watched.balance -= 100;
      watched.history.push({ amount: -100 });
    });
    await wait(10);

    manager.undo();
    assertEquals(LazyWatch.snapshot(watched), { balance: 500, history: [] },
      'one undo should revert the whole transaction');
    assertTrue(!manager.canUndo);
    LazyWatch.dispose(watched);
  });

  runner.test('undo manager should enable inverse recording and restore it on dispose', async () => {
    const watched = new LazyWatch({ n: 0 });
    const inverses = [];
    LazyWatch.on(watched, (diff, inverse) => inverses.push(inverse));

    const manager = LazyWatch.createUndoManager(watched);
    watched.n = 1;
    await wait(10);
    assertEquals(inverses.length, 1);
    assertTrue(inverses[0] !== undefined, 'inverse recording should be active while the manager exists');

    manager.dispose();
    assertTrue(!manager.canUndo && !manager.canRedo, 'disposal should drop history');
    assertTrue(!manager.undo() && !manager.redo(), 'a disposed manager should refuse to act');
    manager.dispose(); // idempotent

    watched.n = 2;
    await wait(10);
    assertEquals(inverses.length, 2);
    assertTrue(inverses[1] === undefined, 'inverse recording should be restored (off) after disposal');
    LazyWatch.dispose(watched);
  });

  runner.test('undo manager should start from a clean batch boundary', async () => {
    const watched = new LazyWatch({ n: 0 });
    watched.n = 1; // pending when the manager attaches

    const manager = LazyWatch.createUndoManager(watched);
    assertTrue(!manager.canUndo, 'pre-attach changes should not enter the history');
    assertEquals(watched.n, 1, 'pre-attach changes should still be applied');
    LazyWatch.dispose(watched);
  });

  runner.test('silent changes should not be recorded as undo steps', async () => {
    const watched = new LazyWatch({ n: 0 });
    const manager = LazyWatch.createUndoManager(watched);

    LazyWatch.silent(watched, () => { watched.n = 1; });
    await wait(10);
    assertTrue(!manager.canUndo, 'silent changes bypass emission and are not undoable');
    LazyWatch.dispose(watched);
  });

  runner.test('only one undo manager per instance; a new one is allowed after disposal', () => {
    const watched = new LazyWatch({ n: 0 });
    const first = LazyWatch.createUndoManager(watched);
    assertThrows(() => LazyWatch.createUndoManager(watched),
      'a second manager on the same instance should throw');

    first.dispose();
    const second = LazyWatch.createUndoManager(watched); // must not throw
    second.dispose();
    LazyWatch.dispose(watched);
  });

  runner.test('undo manager should reject nested proxies and bad limits', () => {
    const watched = new LazyWatch({ sub: { n: 0 } });
    assertThrows(() => LazyWatch.createUndoManager(watched.sub),
      'nested proxies should be rejected');
    assertThrows(() => LazyWatch.createUndoManager(watched, { limit: 0 }),
      'limit 0 should be rejected');
    assertThrows(() => LazyWatch.createUndoManager(watched, { limit: 2.5 }),
      'fractional limits should be rejected');
    LazyWatch.dispose(watched);
  });

  // --- Undo-step grouping and coalescing ---

  runner.test('group should merge multiple batches into a single undo step', async () => {
    const doc = new LazyWatch({ a: 1, b: 2 });
    const manager = LazyWatch.createUndoManager(doc);

    doc.a = 10;
    await wait(5); // step 1
    manager.group(() => {
      doc.a = 100;
      LazyWatch.flush(doc); // two distinct batches inside the group
      doc.b = 200;
    });
    doc.b = 999;
    await wait(5); // step 3

    assertTrue(manager.undo());
    assertEquals(LazyWatch.snapshot(doc), { a: 100, b: 200 }, 'step 3 undone');
    assertTrue(manager.undo());
    assertEquals(LazyWatch.snapshot(doc), { a: 10, b: 2 }, 'the whole group undone as one step');
    assertTrue(manager.redo());
    assertEquals(LazyWatch.snapshot(doc), { a: 100, b: 200 }, 'the whole group redone as one step');
    LazyWatch.dispose(doc);
  });

  runner.test('group should return the callback value and reject nesting and disposed use', () => {
    const doc = new LazyWatch({ n: 0 });
    const manager = LazyWatch.createUndoManager(doc);
    const result = manager.group(() => { doc.n = 1; return 'done'; });
    assertEquals(result, 'done');
    assertThrows(() => manager.group(() => manager.group(() => {})));
    manager.dispose();
    assertThrows(() => manager.group(() => {}));
    LazyWatch.dispose(doc);
  });

  runner.test('a throwing group callback should record its partial changes as one step and rethrow', () => {
    const doc = new LazyWatch({ a: 1, b: 1 });
    const manager = LazyWatch.createUndoManager(doc);
    assertThrows(() => manager.group(() => {
      doc.a = 2;
      LazyWatch.flush(doc);
      doc.b = 2;
      throw new Error('boom');
    }));
    assertEquals(LazyWatch.snapshot(doc), { a: 2, b: 2 },
      'changes stay applied — group is history bookkeeping, not a transaction');
    manager.undo();
    assertEquals(LazyWatch.snapshot(doc), { a: 1, b: 1 }, 'both batches undone as one step');
    LazyWatch.dispose(doc);
  });

  runner.test('group should fall back to segments for non-composable batches and still undo', () => {
    const doc = new LazyWatch({ k: { x: 1 }, other: 0 });
    const manager = LazyWatch.createUndoManager(doc);
    manager.group(() => {
      delete doc.k;
      LazyWatch.flush(doc);   // batch: { k: null }
      doc.k = { y: 2 };       // object diff after a deletion: no single-diff form
    });
    assertTrue(manager.undo());
    // (key order follows the delete/recreate: 'other' first)
    assertEquals(LazyWatch.snapshot(doc), { other: 0, k: { x: 1 } }, 'multi-segment step fully undone');
    assertTrue(manager.redo());
    assertEquals(LazyWatch.snapshot(doc), { other: 0, k: { y: 2 } }, 'and fully redone');
    LazyWatch.dispose(doc);
  });

  runner.test('undo of a grouped step should reach mirrors as a single batch', async () => {
    const doc = new LazyWatch({ a: 1, b: 1 });
    const mirror = new LazyWatch({ a: 1, b: 1 });
    let batches = 0;
    LazyWatch.on(doc, d => { batches++; LazyWatch.patch(mirror, d); });
    const manager = LazyWatch.createUndoManager(doc);

    manager.group(() => {
      doc.a = 2;
      LazyWatch.flush(doc);
      doc.b = 2;
    });
    const before = batches;
    manager.undo();
    assertEquals(batches, before + 1, 'undo emitted exactly one batch');
    assertConverged(doc, mirror);
    LazyWatch.dispose(doc);
    LazyWatch.dispose(mirror);
  });

  runner.test('coalesce should merge rapid batches into one step and split after the window', async () => {
    const doc = new LazyWatch({ text: '' });
    const manager = LazyWatch.createUndoManager(doc, { coalesce: 60 });

    doc.text = 'h';
    await wait(5);
    doc.text = 'he';
    await wait(5);
    doc.text = 'hel';
    await wait(5);   // all within the sliding 60ms window → one step
    await wait(120); // window expires
    doc.text = 'hello';
    await wait(5);   // new step

    assertTrue(manager.undo());
    assertEquals(doc.text, 'hel', 'post-window step undone alone');
    assertTrue(manager.undo());
    assertEquals(doc.text, '', 'coalesced burst undone as one step');
    assertTrue(!manager.canUndo);
    LazyWatch.dispose(doc);
  });

  runner.test('checkpoint should end the coalescing window', async () => {
    const doc = new LazyWatch({ n: 0 });
    const manager = LazyWatch.createUndoManager(doc, { coalesce: 5000 });
    doc.n = 1;
    await wait(5);
    manager.checkpoint();
    doc.n = 2;
    await wait(5);
    assertTrue(manager.undo());
    assertEquals(doc.n, 1, 'only the post-checkpoint step undone');
    assertTrue(manager.undo());
    assertEquals(doc.n, 0);
    LazyWatch.dispose(doc);
  });

  runner.test('an invalid coalesce option should throw and leave the instance clean', () => {
    const doc = new LazyWatch({ n: 0 });
    assertThrows(() => LazyWatch.createUndoManager(doc, { coalesce: -1 }));
    assertThrows(() => LazyWatch.createUndoManager(doc, { coalesce: 'fast' }));
    const manager = LazyWatch.createUndoManager(doc); // still allowed after failures
    manager.dispose();
    LazyWatch.dispose(doc);
  });

  runner.test('disposing the instance should dispose its undo manager', async () => {
    const watched = new LazyWatch({ n: 0 });
    const manager = LazyWatch.createUndoManager(watched);
    watched.n = 1;
    await wait(10);
    assertTrue(manager.canUndo);

    LazyWatch.dispose(watched);
    assertTrue(!manager.canUndo && !manager.canRedo, 'instance disposal should detach the manager');
    assertTrue(!manager.undo(), 'undo after instance disposal should be a safe no-op');
  });
}
