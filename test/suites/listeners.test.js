// listeners.test.js - Nested-path listeners, flush/once/AbortSignal, subtree notification semantics,
// unsubscribe scoping, snapshot(), deepClone fallback, and emit integrity
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, assertThrows, wait } from '../helpers.js';

export default function register(runner) {
  // Nested proxy listener tests
  runner.test('should emit path-relative diffs for nested proxy listeners', async () => {
    const data = { root: { count: 1 } };
    const watched = new LazyWatch(data, { throttle: 15 });
    let rootChanges = null;
    let nestedChanges = null;

    // Listener on root proxy
    LazyWatch.on(watched, (changes) => {
      rootChanges = changes;
    });

    // Listener on nested proxy
    LazyWatch.on(watched.root, (changes) => {
      nestedChanges = changes;
    });

    watched.root.count++;

    await wait(50);

    // Root listener should receive full diff
    assertEquals(rootChanges, { root: { count: 2 } }, 'Root listener should receive full diff');

    // Nested listener should receive path-relative diff
    assertEquals(nestedChanges, { count: 2 }, 'Nested listener should receive path-relative diff');

    LazyWatch.dispose(watched);
  });

  runner.test('should only notify nested listeners when their subtree changes', async () => {
    const data = {
      users: { name: 'Alice' },
      settings: { theme: 'dark' }
    };
    const watched = new LazyWatch(data);
    let usersChanges = null;
    let settingsChanges = null;

    LazyWatch.on(watched.users, (changes) => {
      usersChanges = changes;
    });

    LazyWatch.on(watched.settings, (changes) => {
      settingsChanges = changes;
    });

    // Only change settings
    watched.settings.theme = 'light';

    await wait(50);

    // Users listener should not be called
    assertEquals(usersChanges, null, 'Users listener should not be called');

    // Settings listener should be called with path-relative diff
    assertEquals(settingsChanges, { theme: 'light' }, 'Settings listener should receive changes');

    LazyWatch.dispose(watched);
  });

  runner.test('should support deeply nested proxy listeners', async () => {
    const data = {
      level1: {
        level2: {
          level3: {
            value: 'deep'
          }
        }
      }
    };
    const watched = new LazyWatch(data);
    let rootChanges = null;
    let level2Changes = null;
    let level3Changes = null;

    LazyWatch.on(watched, (changes) => {
      rootChanges = changes;
    });

    LazyWatch.on(watched.level1.level2, (changes) => {
      level2Changes = changes;
    });

    LazyWatch.on(watched.level1.level2.level3, (changes) => {
      level3Changes = changes;
    });

    watched.level1.level2.level3.value = 'updated';

    await wait(50);

    // Root listener receives full path
    assertEquals(rootChanges, { level1: { level2: { level3: { value: 'updated' } } } },
      'Root listener should receive full diff');

    // Level2 listener receives from level2 down
    assertEquals(level2Changes, { level3: { value: 'updated' } },
      'Level2 listener should receive diff from level2');

    // Level3 listener receives only its own changes
    assertEquals(level3Changes, { value: 'updated' },
      'Level3 listener should receive only its changes');

    LazyWatch.dispose(watched);
  });

  runner.test('should handle multiple listeners on same nested proxy', async () => {
    const data = { settings: { theme: 'dark', lang: 'en' } };
    const watched = new LazyWatch(data);
    let listener1Changes = null;
    let listener2Changes = null;

    const listener1 = (changes) => { listener1Changes = changes; };
    const listener2 = (changes) => { listener2Changes = changes; };

    LazyWatch.on(watched.settings, listener1);
    LazyWatch.on(watched.settings, listener2);

    watched.settings.theme = 'light';

    await wait(50);

    // Both listeners should receive the same path-relative diff
    assertEquals(listener1Changes, { theme: 'light' }, 'Listener 1 should receive changes');
    assertEquals(listener2Changes, { theme: 'light' }, 'Listener 2 should receive changes');

    LazyWatch.dispose(watched);
  });

  runner.test('should work with nested array listeners', async () => {
    const data = {
      lists: {
        todos: [1, 2, 3]
      }
    };
    const watched = new LazyWatch(data);
    let rootChanges = null;
    let todosChanges = null;

    LazyWatch.on(watched, (changes) => {
      rootChanges = changes;
    });

    LazyWatch.on(watched.lists.todos, (changes) => {
      todosChanges = changes;
    });

    watched.lists.todos.push(4);

    await wait(50);

    // Root listener receives full path
    assertTrue(rootChanges.lists.todos[3] === 4, 'Root listener should see array change');

    // Nested array listener receives only array changes
    assertEquals(todosChanges[3], 4, 'Nested listener should see new element');

    LazyWatch.dispose(watched);
  });

  // --- flush(), once(), and AbortSignal listeners ---

  runner.test('flush should emit pending changes synchronously', () => {
    const watched = new LazyWatch({ count: 0 });
    let received = null;
    LazyWatch.on(watched, diff => { received = diff; });

    watched.count = 1;
    assertEquals(received, null, 'nothing emitted before flush');
    LazyWatch.flush(watched);
    assertEquals(received, { count: 1 }, 'flush should emit synchronously');
    LazyWatch.dispose(watched);
  });

  runner.test('flush should bypass debounce and pause, and be a no-op when clean', async () => {
    const watched = new LazyWatch({ count: 0 }, { debounce: 5000 });
    let calls = 0;
    LazyWatch.on(watched, () => { calls++; });

    watched.count = 1;
    LazyWatch.flush(watched);
    assertEquals(calls, 1, 'flush should bypass the debounce timer');

    LazyWatch.flush(watched);
    assertEquals(calls, 1, 'flush with no pending changes should not emit');

    LazyWatch.pause(watched);
    watched.count = 2;
    LazyWatch.flush(watched);
    assertEquals(calls, 2, 'flush should bypass pause');
    LazyWatch.resume(watched);

    await wait(10);
    assertEquals(calls, 2, 'no stray emits after flush');
    LazyWatch.dispose(watched);
  });

  runner.test('once should fire a single time and then be removed', async () => {
    const watched = new LazyWatch({ count: 0 });
    let calls = 0;
    LazyWatch.once(watched, () => { calls++; });

    watched.count = 1;
    await wait(10);
    watched.count = 2;
    await wait(10);

    assertEquals(calls, 1, 'once listener should fire exactly once');
    LazyWatch.dispose(watched);
  });

  runner.test('once on a nested proxy should wait for its subtree', async () => {
    const watched = new LazyWatch({ user: { name: 'a' }, other: 1 });
    let received = null;
    LazyWatch.once(watched.user, diff => { received = diff; });

    watched.other = 2; // unrelated change must not consume the once-listener
    await wait(10);
    assertEquals(received, null, 'unrelated change should not consume once()');

    watched.user.name = 'b';
    await wait(10);
    assertEquals(received, { name: 'b' });

    received = null;
    watched.user.name = 'c';
    await wait(10);
    assertEquals(received, null, 'once listener should be gone after firing');
    LazyWatch.dispose(watched);
  });

  runner.test('once listeners should also be removed via off()', async () => {
    const watched = new LazyWatch({ count: 0 });
    let calls = 0;
    const listener = () => { calls++; };
    LazyWatch.once(watched, listener);
    LazyWatch.off(watched, listener);

    watched.count = 1;
    await wait(10);
    assertEquals(calls, 0, 'off should remove a once listener before it fires');
    LazyWatch.dispose(watched);
  });

  runner.test('AbortSignal should remove listeners on abort', async () => {
    const watched = new LazyWatch({ count: 0 });
    let calls = 0;
    const controller = new AbortController();
    LazyWatch.on(watched, () => { calls++; }, { signal: controller.signal });

    watched.count = 1;
    await wait(10);
    assertEquals(calls, 1, 'listener should fire before abort');

    controller.abort();
    watched.count = 2;
    await wait(10);
    assertEquals(calls, 1, 'listener should not fire after abort');
    LazyWatch.dispose(watched);
  });

  runner.test('an already-aborted signal should never add the listener', async () => {
    const watched = new LazyWatch({ count: 0 });
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    LazyWatch.on(watched, () => { calls++; }, { signal: controller.signal });

    watched.count = 1;
    await wait(10);
    assertEquals(calls, 0);
    LazyWatch.dispose(watched);
  });

  runner.test('a throwing once listener should still be removed', async () => {
    const watched = new LazyWatch({ count: 0 });
    let calls = 0;
    const origError = console.error;
    console.error = () => {}; // silence the expected listener-error log
    try {
      LazyWatch.once(watched, () => { calls++; throw new Error('boom'); });

      watched.count = 1;
      await wait(10);
      watched.count = 2;
      await wait(10);
    } finally {
      console.error = origError;
    }

    assertEquals(calls, 1, 'throwing once listener should fire exactly once');
    LazyWatch.dispose(watched);
  });

  // --- patch atomicity and nested-listener subtree semantics ---

  runner.test('a throwing patch should not corrupt later overwrite semantics', () => {
    const watched = new LazyWatch({ a: 1, b: 2 });
    assertThrows(() => LazyWatch.patch(watched, { c: new Map() }));

    // overwrite must still delete missing properties after the failed patch
    LazyWatch.overwrite(watched, { a: 10 });
    assertEquals(watched.a, 10);
    assertTrue(!('b' in LazyWatch.resolveIfProxy(watched)),
      'overwrite should still delete missing properties after a failed patch');
    LazyWatch.dispose(watched);
  });

  runner.test('nested listener should receive null when its subtree is deleted', async () => {
    const watched = new LazyWatch({ user: { name: 'x' }, other: 1 });
    let received = 'never-called';
    LazyWatch.on(watched.user, d => { received = d; });

    delete watched.user;
    await wait(10);

    assertEquals(received, null, 'subtree deletion should notify with null');
    LazyWatch.dispose(watched);
  });

  runner.test('nested listener should receive the leaf value when its subtree is replaced', async () => {
    const watched = new LazyWatch({ user: { name: 'x' } });
    let received = 'never-called';
    LazyWatch.on(watched.user, d => { received = d; });

    watched.user = 'hello';
    await wait(10);

    assertEquals(received, 'hello', 'wholesale replacement should deliver the new value');
    LazyWatch.dispose(watched);
  });

  runner.test('nested listener should receive null when an ancestor is deleted or replaced', async () => {
    const watched = new LazyWatch({ a: { b: { c: 1 } } });
    let received = 'never-called';
    LazyWatch.on(watched.a.b, d => { received = d; });

    watched.a = 5; // ancestor replaced by a leaf destroys the b subtree
    await wait(10);

    assertEquals(received, null, 'ancestor replacement should notify with null');
    LazyWatch.dispose(watched);
  });

  runner.test('falsy leaf replacements should still notify nested listeners', async () => {
    const watched = new LazyWatch({ flag: { on: true } });
    let received = 'never-called';
    LazyWatch.on(watched.flag, d => { received = d; });

    watched.flag = false;
    await wait(10);

    assertEquals(received, false, 'replacement by false should be delivered, not skipped');
    LazyWatch.dispose(watched);
  });

  runner.test('off should remove the registration on the given proxy, not just the first match', async () => {
    const watched = new LazyWatch({ a: { x: 1 }, b: { y: 1 } });
    const log = [];
    const fn = d => log.push(d);
    LazyWatch.on(watched.a, fn);
    LazyWatch.on(watched.b, fn);

    LazyWatch.off(watched.b, fn); // must remove the b registration, not a's
    watched.b.y = 2;
    watched.a.x = 2;
    await wait(10);

    assertEquals(log, [{ x: 2 }], 'a listener should survive, b listener should be gone');
    LazyWatch.dispose(watched);
  });

  runner.test('off on the root should not remove a nested registration of the same function', async () => {
    const watched = new LazyWatch({ a: { x: 1 } });
    let calls = 0;
    const fn = () => { calls++; };
    LazyWatch.on(watched.a, fn);

    LazyWatch.off(watched, fn); // root path has no such registration
    watched.a.x = 2;
    await wait(10);

    assertEquals(calls, 1, 'nested registration should survive off() on the root');
    LazyWatch.dispose(watched);
  });

  runner.test('aborting a signal should remove only its own registration of a shared function', async () => {
    const watched = new LazyWatch({ a: { x: 1 }, b: { y: 1 } });
    const log = [];
    const fn = d => log.push(d);
    const controller = new AbortController();
    LazyWatch.on(watched.a, fn, { signal: controller.signal });
    LazyWatch.on(watched.b, fn);

    controller.abort(); // must remove the a registration, not b's
    watched.a.x = 2;
    watched.b.y = 2;
    await wait(10);

    assertEquals(log, [{ y: 2 }], 'b listener should survive the abort of a\'s signal');
    LazyWatch.dispose(watched);
  });

  runner.test('nested listeners should stay silent for untouched subtrees', async () => {
    const watched = new LazyWatch({ user: { name: 'x' }, other: 1 });
    let calls = 0;
    LazyWatch.on(watched.user, () => { calls++; });

    watched.other = 2;
    delete watched.other;
    await wait(10);

    assertEquals(calls, 0, 'changes outside the subtree must not notify');
    LazyWatch.dispose(watched);
  });

  // --- unsubscribe from on(), snapshot(), deepClone fallback ---

  runner.test('on should return an idempotent unsubscribe function', async () => {
    const watched = new LazyWatch({ count: 0 });
    let calls = 0;
    const stop = LazyWatch.on(watched, () => { calls++; });

    watched.count = 1;
    await wait(10);
    assertEquals(calls, 1);

    stop();
    watched.count = 2;
    await wait(10);
    assertEquals(calls, 1, 'unsubscribed listener should not fire');

    stop(); // second call must be a harmless no-op
    LazyWatch.dispose(watched);
  });

  runner.test('unsubscribe should remove only its own registration of a shared function', async () => {
    const watched = new LazyWatch({ a: { x: 1 }, b: { y: 1 } });
    const log = [];
    const fn = d => log.push(d);
    const stopA = LazyWatch.on(watched.a, fn);
    LazyWatch.on(watched.b, fn);

    stopA();
    watched.a.x = 2;
    watched.b.y = 2;
    await wait(10);

    assertEquals(log, [{ y: 2 }], 'only the a registration should be removed');
    LazyWatch.dispose(watched);
  });

  runner.test('once should return an unsubscribe that works before the first fire', async () => {
    const watched = new LazyWatch({ count: 0 });
    let calls = 0;
    const stop = LazyWatch.once(watched, () => { calls++; });

    stop();
    watched.count = 1;
    await wait(10);

    assertEquals(calls, 0, 'unsubscribed once listener should never fire');
    LazyWatch.dispose(watched);
  });

  runner.test('on with an already-aborted signal should return a no-op unsubscribe', () => {
    const watched = new LazyWatch({ count: 0 });
    const controller = new AbortController();
    controller.abort();
    const stop = LazyWatch.on(watched, () => {}, { signal: controller.signal });

    assertTrue(typeof stop === 'function', 'should still return a function');
    stop(); // must not throw
    LazyWatch.dispose(watched);
  });

  runner.test('snapshot should return an independent deep clone', async () => {
    const watched = new LazyWatch({ user: { name: 'Alice', tags: ['a'] }, when: new Date(0) });
    let calls = 0;
    LazyWatch.on(watched, () => { calls++; });

    const snap = LazyWatch.snapshot(watched);
    assertEquals(snap, { user: { name: 'Alice', tags: ['a'] }, when: new Date(0) });
    assertTrue(snap.when instanceof Date, 'Date leaves should keep their type');
    assertTrue(!LazyWatch.isProxy(snap), 'snapshot should be a plain object, not a proxy');

    // Mutating the snapshot must not touch the watched object or emit
    snap.user.name = 'Bob';
    snap.user.tags.push('b');
    await wait(10);
    assertEquals(calls, 0, 'snapshot mutations must not emit');
    assertEquals(watched.user.name, 'Alice');
    LazyWatch.dispose(watched);
  });

  runner.test('snapshot of a nested proxy should clone just that subtree', () => {
    const watched = new LazyWatch({ user: { name: 'Alice' }, other: 1 });
    const snap = LazyWatch.snapshot(watched.user);
    assertEquals(snap, { name: 'Alice' });
    LazyWatch.dispose(watched);
  });

  runner.test('snapshot should throw after disposal', () => {
    const watched = new LazyWatch({ a: 1 });
    LazyWatch.dispose(watched);
    assertThrows(() => LazyWatch.snapshot(watched));
  });

  runner.test('deepClone fallback should handle functions by reference', () => {
    // structuredClone throws on functions, forcing the manual fallback path
    const fn = () => 42;
    const source = { fn, nested: { list: [1, { deep: true }], when: new Date(0) } };
    const clone = LazyWatch.Utils.deepClone(source);

    assertTrue(clone.fn === fn, 'functions should be copied by reference');
    assertTrue(clone.nested !== source.nested, 'containers should be cloned');
    assertTrue(clone.nested.list[1] !== source.nested.list[1], 'deep containers should be cloned');
    assertTrue(clone.nested.when instanceof Date, 'Date should survive the fallback');
    assertEquals(clone.nested.list, [1, { deep: true }]);
  });

  runner.test('deepClone fallback should handle cycles', () => {
    const source = { fn: () => {} }; // function forces the manual path
    source.self = source;
    const clone = LazyWatch.Utils.deepClone(source);
    assertTrue(clone.self === clone, 'cycle should point at the clone, not the source');
  });

  runner.test('a listener unsubscribing itself during emit should not skip later listeners', async () => {
    const watched = new LazyWatch({ count: 0 });
    const calls = [];
    const stop = LazyWatch.on(watched, () => { calls.push(1); stop(); });
    LazyWatch.on(watched, () => calls.push(2));
    LazyWatch.on(watched, () => calls.push(3));

    watched.count = 1;
    await wait(10);
    assertEquals(calls, [1, 2, 3], 'all listeners registered at emit time should fire');

    watched.count = 2;
    await wait(10);
    assertEquals(calls, [1, 2, 3, 2, 3], 'the unsubscribed listener should stay removed');
    LazyWatch.dispose(watched);
  });

  runner.test('a listener removed during emit by an earlier listener should not fire', async () => {
    const watched = new LazyWatch({ count: 0 });
    const calls = [];
    const second = () => calls.push(2);
    LazyWatch.on(watched, () => { calls.push(1); LazyWatch.off(watched, second); });
    LazyWatch.on(watched, second);
    LazyWatch.on(watched, () => calls.push(3));

    watched.count = 1;
    await wait(10);
    assertEquals(calls, [1, 3], 'a listener removed mid-emit must not be invoked');
    LazyWatch.dispose(watched);
  });

  runner.test('emitted diffs should not alias live state', async () => {
    const watched = new LazyWatch({});
    let captured = null;
    LazyWatch.on(watched, diff => { if (!captured) captured = diff; });

    watched.obj = { x: 1, list: ['a'] };
    await wait(10);
    assertEquals(captured, { obj: { x: 1, list: ['a'] } });

    // Mutating the same subtree later must not rewrite the diff the
    // listener kept (send buffers, undo stacks, ...)
    watched.obj.x = 999;
    watched.obj.list.push('b');
    await wait(10);
    assertEquals(captured, { obj: { x: 1, list: ['a'] } },
      'a diff held past its emit must not change when state changes later');
    LazyWatch.dispose(watched);
  });

  runner.test('silent should return a diff that does not alias live state', () => {
    const watched = new LazyWatch({});
    const diff = LazyWatch.silent(watched, () => { watched.obj = { x: 1 }; });

    watched.obj.x = 2;
    assertEquals(diff, { obj: { x: 1 } },
      'the returned diff must not change when state changes later');
    LazyWatch.dispose(watched);
  });
}
