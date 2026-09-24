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

  runner.test('consecutive once listeners should each fire exactly once', () => {
    // Removing fired entries from the live list while iterating it skipped
    // every other one: three once listeners over three flushes fired 1, 2, 1
    const watched = new LazyWatch({ a: 0 });
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < counts.length; i++) {
      LazyWatch.once(watched, () => { counts[i]++; });
    }
    for (let n = 1; n <= 3; n++) {
      watched.a = n;
      LazyWatch.flush(watched);
    }
    assertEquals(counts, [1, 1, 1, 1], 'every once listener should fire exactly once');
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

  // --- batches produced while a delivery is running ---

  runner.test('a batch a listener produces should reach later listeners after the batch they are owed', async () => {
    // Listener A rejects a batch by applying its inverse with metadata. The
    // tagged batch used to be force-emitted on the spot, so listener B got
    // it before the batch it was still owed and its mirror ended at 99
    const watched = new LazyWatch({ x: 1 }, { inverse: true });
    const mirror = { x: 1 };
    const seen = [];
    LazyWatch.on(watched, (diff, inverse, meta) => {
      if (!meta && diff.x === 99) LazyWatch.patch(watched, inverse, { origin: 'rejected' });
    });
    LazyWatch.on(watched, (diff, inverse, meta) => {
      seen.push([diff.x, meta?.origin]);
      LazyWatch.patch(mirror, diff);
    });

    watched.x = 99;
    await wait(0);
    assertEquals(seen, [[99, undefined], [1, 'rejected']], 'batches should arrive in production order');
    assertEquals(mirror, { x: 1 }, 'the mirror should converge');
    assertEquals(LazyWatch.snapshot(watched), { x: 1 });
    LazyWatch.dispose(watched);
  });

  runner.test('flush inside a listener should split the batch now and deliver it before the outer flush returns', () => {
    const watched = new LazyWatch({ a: 0, b: 0 });
    const log = [];
    LazyWatch.on(watched, (diff, inverse, meta) => {
      log.push(['first', diff, meta]);
      if (diff.a === 1) {
        watched.b = 1;
        LazyWatch.flush(watched, { origin: 'inner' });
        // Consumed at the call, delivered after the current batch
        log.push(['pending', LazyWatch.getPendingDiff(watched)]);
        watched.b = 2; // joins a later batch, not the flushed one
        log.push(['first returns']);
      }
    });
    LazyWatch.on(watched, (diff, inverse, meta) => log.push(['second', diff, meta]));

    watched.a = 1;
    LazyWatch.flush(watched);
    assertEquals(log, [
      ['first', { a: 1 }, undefined],
      ['pending', {}],
      ['first returns'],
      ['second', { a: 1 }, undefined],
      ['first', { b: 1 }, { origin: 'inner' }],
      ['second', { b: 1 }, { origin: 'inner' }]
    ], 'the inner batch should be delivered after the outer one, before flush returns');
    assertEquals(LazyWatch.getPendingDiff(watched), { b: 2 }, 'later writes stay pending');
    LazyWatch.dispose(watched);
  });

  runner.test('deferred batches should keep once, nested-path, and registration-time semantics', () => {
    const watched = new LazyWatch({ a: 0, user: { name: 'x' } });
    const log = [];
    let lateAdded = false;
    LazyWatch.on(watched, diff => {
      if (diff.a !== 1) return;
      LazyWatch.on(watched, d => log.push(['early', d])); // registered before batch 2 exists
      watched.user.name = 'y';
      LazyWatch.flush(watched);
      LazyWatch.on(watched, d => { lateAdded = true; log.push(['late', d]); }); // after it
    });
    LazyWatch.once(watched, d => log.push(['once', d]));
    LazyWatch.once(watched.user, d => log.push(['user once', d]));

    watched.a = 1;
    LazyWatch.flush(watched);
    assertEquals(log, [
      ['once', { a: 1 }],
      ['user once', { name: 'y' }],
      ['early', { user: { name: 'y' } }]
    ], 'once fires on its first batch only; the nested once waits for its subtree; ' +
      'a listener added after a batch was produced waits for the next one');
    assertTrue(!lateAdded, 'the late listener should not receive the deferred batch');

    watched.a = 2;
    watched.user.name = 'z';
    LazyWatch.flush(watched);
    assertEquals(log.length, 5, 'only early and late fire on the next batch');
    assertTrue(lateAdded);
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

  runner.test('a nested listener should receive null when its object is replaced, and not follow what replaced it', async () => {
    const watched = new LazyWatch({ user: { name: 'x' } });
    const log = [];
    LazyWatch.on(watched.user, d => log.push(d));

    watched.user = 'hello';
    await wait(10);
    assertEquals(log, [null], 'the object left the tree');

    watched.user = { name: 'y' };
    await wait(10);
    assertEquals(log, [null], 'a new object at the same path is another object');
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

    assertEquals(received, null, 'replacement by false should be delivered (the object is gone), not skipped');
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
    const watched = new LazyWatch({ user: { name: 'Alice', tags: ['a'] }, when: 0 });
    let calls = 0;
    LazyWatch.on(watched, () => { calls++; });

    const snap = LazyWatch.snapshot(watched);
    assertEquals(snap, { user: { name: 'Alice', tags: ['a'] }, when: 0 });
    assertTrue(!LazyWatch.isProxy(snap), 'snapshot should be a plain object, not a proxy');
    assertTrue(!LazyWatch.isProxy(snap.user), 'nested containers should be plain too');

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

  // --- Listeners under array elements ---
  // A listener on a nested proxy listens to that object: it follows the
  // object wherever structural ops move it, hears only the object's own
  // changes, null when it leaves the tree, and nothing about the elements
  // that take its old place.
  runner.test('element listeners should follow their objects: a move alone tells them nothing', async () => {
    const watched = new LazyWatch({ todos: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const log = [];
    for (const todo of watched.todos) {
      const id = todo.id;
      LazyWatch.on(todo, d => log.push([id, d]));
    }

    watched.todos.unshift({ id: 0 });
    watched.todos.reverse();
    await wait(10);
    assertEquals(log, [], 'moved, not changed');

    watched.todos.find(t => t.id === 2).done = true;
    await wait(10);
    assertEquals(log, [[2, { done: true }]], 'a write reaches the object written, wherever it moved');
    LazyWatch.dispose(watched);
  });

  runner.test('a splice replacing an element should tell its listener null, and its neighbours nothing', async () => {
    const watched = new LazyWatch({ todos: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const log = [];
    for (const todo of watched.todos) {
      const id = todo.id;
      LazyWatch.on(todo, d => log.push([id, d]));
    }

    watched.todos.splice(1, 1, { id: 9 });
    await wait(10);
    assertEquals(log, [[2, null]]);
    LazyWatch.dispose(watched);
  });

  runner.test('element listeners should receive null once when truncation removes their objects, and not follow what comes after', async () => {
    const watched = new LazyWatch({ todos: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const log = [];
    LazyWatch.on(watched.todos[1], d => log.push(['2', d]));
    LazyWatch.on(watched.todos[2], d => log.push(['3', d]));

    watched.todos.length = 1;
    await wait(10);
    assertEquals(log.sort(), [['2', null], ['3', null]]);

    log.length = 0;
    watched.todos.push({ id: 4 });
    watched.todos.push({ id: 5 });
    await wait(10);
    assertEquals(log, [], 'new elements at the old indices are other objects');
    LazyWatch.dispose(watched);
  });

  runner.test('a listener below a moved element should follow it; one below a removed element should receive null', async () => {
    const watched = new LazyWatch({
      todos: [{ id: 1, tags: ['a'] }, { id: 2, tags: ['b'] }, { id: 3, tags: ['c'] }]
    });
    const log = [];
    LazyWatch.on(watched.todos[1].tags, d => log.push(['2.tags', d]));
    LazyWatch.on(watched.todos[2].tags, d => log.push(['3.tags', d]));

    watched.todos.splice(0, 2); // [id 3] remains, at index 0
    await wait(10);
    assertEquals(log, [['2.tags', null]]);

    log.length = 0;
    watched.todos.unshift({ id: 0, tags: ['z'] });
    watched.todos[1].tags.push('d'); // id 3's tags, now at index 1
    await wait(10);
    assertEquals(log, [['3.tags', { 1: 'd', $length: 2 }]]);
    LazyWatch.dispose(watched);
  });

  runner.test('what a batch changed in an element before moving it should reach the element\'s listener', async () => {
    // A move takes the element out of the array and back in: the diff
    // carries it whole in a $splice op, so the listener gets its value,
    // with what the batch deleted in it marked
    const watched = new LazyWatch({ todos: [{ id: 1 }, { id: 2, x: 1 }] });
    let received = 'never-called';
    LazyWatch.on(watched.todos[1], d => { received = d; });

    watched.todos[1].done = true;
    delete watched.todos[1].x;
    watched.todos.reverse();
    await wait(10);
    assertEquals(received, { id: 2, done: true, x: null });
    assertEquals(LazyWatch.snapshot(watched.todos[0]), { id: 2, done: true });
    LazyWatch.dispose(watched);
  });

  runner.test('relayed $splice ops should keep element listeners on the mirror following their objects', async () => {
    const src = new LazyWatch({ todos: [{ id: 1 }, { id: 2 }] });
    const mirror = new LazyWatch({ todos: [{ id: 1 }, { id: 2 }] });
    LazyWatch.on(src, d => LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d))));
    const log = [];
    LazyWatch.on(mirror.todos[1], d => log.push(d));

    src.todos.unshift({ id: 0 });
    await wait(10);
    assertEquals(log, []);

    src.todos[2].done = true;
    await wait(10);
    assertEquals(log, [{ done: true }]);
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  runner.test('structural ops should record compactly, element listeners or not', async () => {
    const watched = new LazyWatch({ todos: [{ id: 1, done: true }, { id: 2 }] });
    const diffs = [];
    LazyWatch.on(watched, d => diffs.push(d));
    let received = 'never-called';
    LazyWatch.on(watched.todos[0], d => { received = d; });

    watched.todos.unshift({ id: 0 });
    await wait(10);
    assertEquals(received, 'never-called');
    assertEquals(diffs[0].todos, { $splice: [[0, 0, [{ id: 0 }]]], $length: 3 });
    LazyWatch.dispose(watched);
  });

  runner.test('a listener under an array replaced by a plain object should receive null', async () => {
    const watched = new LazyWatch({ e: [{ id: 1 }, { id: 2 }], o: { 0: 'zero', 1: 'one' } });
    const log = [];
    LazyWatch.on(watched.e[1], d => log.push(['e.1', d]));
    LazyWatch.on(watched.o, d => log.push(['o', d]));

    watched.e = { b: 1 };  // kind change: the element e.1 is gone
    watched.o.x = 2;       // an object merge with an index-like sibling key left alone
    await wait(10);
    assertEquals(log, [['e.1', null], ['o', { x: 2 }]]);

    // What later lands at the old path is another object
    log.length = 0;
    watched.e = { 1: 'back' };
    await wait(10);
    assertEquals(log, []);
    LazyWatch.dispose(watched);
  });

  runner.test('a listener under an object replaced by an array should receive null', async () => {
    const watched = new LazyWatch({ o: { k: { n: 1 } } });
    let received = 'never-called';
    LazyWatch.on(watched.o.k, d => { received = d; });

    watched.o = [1, 2];
    await wait(10);
    assertEquals(received, null);
    LazyWatch.dispose(watched);
  });

  runner.test('element listeners should get their object\'s inverse, from where it was when the batch began', async () => {
    const watched = new LazyWatch({ todos: [{ id: 1 }, { id: 2 }] }, { inverse: true });
    const log = [];
    LazyWatch.on(watched.todos[1], (d, inv) => log.push([d, inv]));

    watched.todos.unshift({ id: 0 });
    await wait(10);
    assertEquals(log, [], 'moved, not changed');

    watched.todos[2].done = true;
    await wait(10);
    assertEquals(log, [[{ done: true }, { done: null }]]);
    LazyWatch.dispose(watched);
  });
}
