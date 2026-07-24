// core.test.js - Basic functionality, listener management, overwrite/patch basics, edge cases, static methods, and performance
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertObjectEqual, assertTrue, assertThrows, wait } from '../helpers.js';

export default function register(runner) {
  // Basic functionality tests
  runner.test('should create a LazyWatch instance', () => {
    const data = { count: 0 };
    const watched = new LazyWatch(data);
    assertTrue(watched !== null);
    LazyWatch.dispose(watched);
  });

  runner.test('should throw error for non-object input', () => {
    assertThrows(() => new LazyWatch(null));
    assertThrows(() => new LazyWatch(42));
    assertThrows(() => new LazyWatch('string'));
  });

  runner.test('should detect simple property changes', async () => {
    const data = { count: 0 };
    const watched = new LazyWatch(data);
    let changesCaught = null;

    LazyWatch.on(watched, (changes) => {
      changesCaught = changes;
    });

    watched.count = 1;

    await wait(50);

    assertEquals(changesCaught, { count: 1 });
    LazyWatch.dispose(watched);
  });

  runner.test('should detect nested property changes', async () => {
    const data = { user: { name: 'Alice' } };
    const watched = new LazyWatch(data);
    let changesCaught = null;

    LazyWatch.on(watched, (changes) => {
      changesCaught = changes;
    });

    watched.user.name = 'Bob';

    await wait(50);

    assertEquals(changesCaught, { user: { name: 'Bob' } });
    LazyWatch.dispose(watched);
  });

  runner.test('should detect array changes', async () => {
    const data = { items: [1, 2, 3] };
    const watched = new LazyWatch(data);
    let changesCaught = null;

    LazyWatch.on(watched, (changes) => {
      changesCaught = changes;
    });

    watched.items[0] = 10;
    watched.items.splice(1, 1);

    await wait(50);

    // The truncation cleanup drops the redundant `2: null` entry — the
    // receiver's length assignment trims that index anyway
    assertEquals(changesCaught, { items: { 0: 10, 1: 3, length: 2 } });
    LazyWatch.dispose(watched);
  });

  runner.test('should detect array push', async () => {
    const data = { items: [1, 2, 3] };
    const watched = new LazyWatch(data);
    let changesCaught = null;

    LazyWatch.on(watched, (changes) => {
      changesCaught = changes;
    });

    watched.items.push(4);

    await wait(50);

    assertEquals(changesCaught.items[3], 4);
    LazyWatch.dispose(watched);
  });

  runner.test('should detect property deletion', async () => {
    const data = { a: 1, b: 2 };
    const watched = new LazyWatch(data);
    let changesCaught = null;

    LazyWatch.on(watched, (changes) => {
      changesCaught = changes;
    });

    delete watched.b;

    await wait(50);

    assertEquals(changesCaught, { b: null });
    LazyWatch.dispose(watched);
  });

  runner.test('should batch multiple changes', async () => {
    const data = { a: 1, b: 2, c: 3 };
    const watched = new LazyWatch(data);
    let callCount = 0;
    let changesCaught = null;

    LazyWatch.on(watched, (changes) => {
      callCount++;
      changesCaught = changes;
    });

    watched.a = 10;
    watched.b = 20;
    watched.c = 30;

    await wait(50);

    assertEquals(changesCaught, { a: 10, b: 20, c: 30 });
    assertEquals(callCount, 1, 'Should only emit once');
    LazyWatch.dispose(watched);
  });

  // Listener management tests
  runner.test('should support multiple listeners', async () => {
    const data = { count: 0 };
    const watched = new LazyWatch(data);
    let calls = 0;

    const listener1 = () => { calls++; };
    const listener2 = () => { calls++; };

    LazyWatch.on(watched, listener1);
    LazyWatch.on(watched, listener2);

    watched.count = 1;

    await wait(50);

    assertEquals(calls, 2, 'Both listeners should be called');
    LazyWatch.dispose(watched);
  });

  runner.test('should remove listeners with off()', async () => {
    const data = { count: 0 };
    const watched = new LazyWatch(data);
    let calls = 0;

    const listener = () => { calls++; };

    LazyWatch.on(watched, listener);
    LazyWatch.off(watched, listener);

    watched.count = 1;

    await wait(50);

    assertEquals(calls, 0, 'Listener should not be called after removal');
    LazyWatch.dispose(watched);
  });

  // Overwrite and patch tests
  runner.test('should overwrite object properties and track changes', async () => {
    const data = {a: 1, b: 2, c: 3};
    const watched = new LazyWatch(data);
    let changesCaught = null;

    LazyWatch.on(watched, diff => {
      changesCaught = diff;
    });

    LazyWatch.overwrite(watched, {a: 10, d: 4});

    assertEquals(watched.a, 10);
    assertEquals(watched.d, 4);
    assertEquals(watched.b, undefined, 'b should be deleted');
    assertEquals(watched.c, undefined, 'c should be deleted');

    await wait(50);

    assertObjectEqual(changesCaught, {a: 10, b: null, c: null, d: 4}, 'Changes should be tracked correctly');

    LazyWatch.dispose(watched);
  });

  runner.test('should overwrite nested object properties and track changes', async () => {
    const data = {obj: {a: 1, b: 2, c: 3}};
    const watched = new LazyWatch(data);
    let changesCaught = null;

    LazyWatch.on(watched, diff => {
      changesCaught = diff;
    });

    watched.obj = {a: 10, d: 4};

    assertEquals(watched.obj.a, 10);
    assertEquals(watched.obj.d, 4);
    assertEquals(watched.obj.b, undefined, 'b should be deleted');
    assertEquals(watched.obj.c, undefined, 'c should be deleted');

    await wait(50);

    // Match property order of actual output
    assertObjectEqual(changesCaught, {obj: {a: 10, d: 4, b: null, c: null}}, 'Nested changes should be tracked correctly');

    LazyWatch.dispose(watched);
  });

  runner.test('should overwrite object properties and track changes', async () => {
    const data = {a: 1, b: 2, c: 3};
    const watched = new LazyWatch(data);
    let changesCaught = null;

    LazyWatch.on(watched, diff => {
      changesCaught = diff;
    });

    LazyWatch.overwrite(watched, {a: 10, d: 4});

    assertEquals(watched.a, 10);
    assertEquals(watched.d, 4);
    assertEquals(watched.b, undefined, 'b should be deleted');
    assertEquals(watched.c, undefined, 'c should be deleted');

    await wait(50);

    // Match property order of actual output
    assertEquals(changesCaught, {a: 10, d: 4, b: null, c: null}, 'Changes should be tracked correctly');

    LazyWatch.dispose(watched);
  });

  // Edge cases
  runner.test('should handle circular references', () => {
    const data = { name: 'obj' };
    data.self = data;

    const watched = new LazyWatch(data);
    assertEquals(watched.self.name, 'obj');
    LazyWatch.dispose(watched);
  });

  runner.test('should handle Date objects', () => {
    const date = new Date('2025-01-01');
    const data = { created: date };
    const watched = new LazyWatch(data);

    assertEquals(watched.created.getTime(), date.getTime());
    LazyWatch.dispose(watched);
  });

  runner.test('should handle null values', async () => {
    const data = { value: 'something' };
    const watched = new LazyWatch(data);
    let changesCaught = null;

    LazyWatch.on(watched, (changes) => {
      changesCaught = changes;
    });

    watched.value = null;

    await wait(50);

    assertEquals(changesCaught, { value: null });
    LazyWatch.dispose(watched);
  });

  runner.test('should handle undefined values', () => {
    const data = { value: 'something' };
    const watched = new LazyWatch(data);

    watched.value = undefined;
    assertEquals(watched.value, undefined);

    LazyWatch.dispose(watched);
  });

  runner.test('should prevent usage after disposal', () => {
    const data = { count: 0 };
    const watched = new LazyWatch(data);

    LazyWatch.dispose(watched);

    assertThrows(() => LazyWatch.on(watched, () => {}));
    assertThrows(() => LazyWatch.off(watched, () => {}));
    assertThrows(() => LazyWatch.overwrite(watched, {}));
    assertThrows(() => LazyWatch.patch(watched, {}));
  });

  // Static method tests
  runner.test('should resolve proxy to original', () => {
    const original = { a: 1 };
    const watched = new LazyWatch(original);

    const resolved = LazyWatch.resolveIfProxy(watched);
    assertTrue(resolved === original || JSON.stringify(resolved) === JSON.stringify(original));

    LazyWatch.dispose(watched);
  });

  // Performance test
  runner.test('should handle large number of changes efficiently', async () => {
    const data = { items: [] };
    const watched = new LazyWatch(data);
    let changesCaught = null;

    const start = Date.now();

    LazyWatch.on(watched, (changes) => {
      changesCaught = changes;
    });

    for (let i = 0; i < 1000; i++) {
      watched.items.push(i);
    }

    await wait(100);

    const elapsed = Date.now() - start;
    assertTrue(elapsed < 1000, `Should complete in under 1s, took ${elapsed}ms`);
    assertTrue(changesCaught !== null, 'Changes should be detected');
    LazyWatch.dispose(watched);
  });
}
