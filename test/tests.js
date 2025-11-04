// tests.js - Comprehensive test suite for LazyWatch
import { LazyWatch } from '../src/lazy-watch.js';

/**
 * Simple test runner
 */
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log('Running LazyWatch tests...\n');

    for (const { name, fn } of this.tests) {
      try {
        await fn();
        this.passed++;
        console.log(`✓ ${name}`);
      } catch (e) {
        this.failed++;
        console.error(`✗ ${name}`);
        console.error(`  ${e.message}`);
      }
    }

    console.log(`\n${this.passed} passed, ${this.failed} failed`);
  }
}

function assertEquals(actual, expected, message = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}

function assertObjectEqual(actual, expected, message = '') {
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);

  if (actualKeys.length !== expectedKeys.length) {
    throw new Error(`${message}\nObjects have different number of keys.\nExpected keys: ${expectedKeys.length}\nActual keys: ${actualKeys.length}`);
  }

  for (const key of expectedKeys) {
    if (typeof expected[key] === 'object' && expected[key] !== null) {
      assertObjectEqual(actual[key], expected[key], `${message}\nNested object at key "${key}"`);
    } else if (actual[key] !== expected[key]) {
      throw new Error(`${message}\nKey "${key}" has different values.\nExpected: ${expected[key]}\nActual: ${actual[key]}`);
    }
  }
}

function assertTrue(value, message = 'Expected true') {
  if (!value) {
    throw new Error(message);
  }
}

function assertThrows(fn, message = 'Expected function to throw') {
  try {
    fn();
    throw new Error(message);
  } catch (e) {
    if (e.message === message) throw e;
  }
}

// Helper to wait for async operations
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test suite
const runner = new TestRunner();

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

  assertEquals(changesCaught, { items: { 0: 10, 1: 3, 2: null, length: 2 } });
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

// Throttle tests
runner.test('should throttle emits with throttle option', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data, { throttle: 50 });
  const emitTimes = [];

  LazyWatch.on(watched, () => {
    emitTimes.push(Date.now());
  });

  // First change - should emit immediately
  watched.count = 1;
  await wait(10);

  // Second change within throttle window - should be delayed
  watched.count = 2;
  await wait(10);

  // Third change within throttle window - should be batched with second
  watched.count = 3;
  await wait(60); // Wait for throttle to complete

  // Fourth change after throttle window - should emit immediately
  watched.count = 4;
  await wait(10);

  assertTrue(emitTimes.length >= 2, `Expected at least 2 emits, got ${emitTimes.length}`);

  // Check that first and second emits are at least 50ms apart
  if (emitTimes.length >= 2) {
    const timeBetween = emitTimes[1] - emitTimes[0];
    assertTrue(timeBetween >= 45, `Expected at least 45ms between emits, got ${timeBetween}ms`);
  }

  LazyWatch.dispose(watched);
});

runner.test('should batch multiple changes within throttle window', async () => {
  const data = { a: 0, b: 0, c: 0 };
  const watched = new LazyWatch(data, { throttle: 50 });
  let emitCount = 0;
  let lastChanges = null;

  LazyWatch.on(watched, (changes) => {
    emitCount++;
    lastChanges = changes;
  });

  // Make multiple changes quickly
  watched.a = 1;
  watched.b = 2;
  watched.c = 3;

  await wait(70);

  // Should have emitted once with all changes
  assertEquals(emitCount, 1, 'Should emit once');
  assertTrue(lastChanges.a === 1 && lastChanges.b === 2 && lastChanges.c === 3, 'Should include all changes');

  LazyWatch.dispose(watched);
});

runner.test('should work without throttle option (default behavior)', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data);
  let changesCaught = null;

  LazyWatch.on(watched, (changes) => {
    changesCaught = changes;
  });

  watched.count = 1;
  await wait(10);

  assertTrue(changesCaught !== null, 'Should detect changes without throttle');
  assertEquals(changesCaught.count, 1);

  LazyWatch.dispose(watched);
});

// getPendingDiff tests
runner.test('should return pending diff without consuming it', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data);
  let changesCaught = null;

  LazyWatch.on(watched, (changes) => {
    changesCaught = changes;
  });

  watched.count = 1;
  watched.count = 2;

  // Get pending diff before it's emitted
  const pendingDiff = LazyWatch.getPendingDiff(watched);
  assertEquals(pendingDiff.count, 2, 'Should return pending changes');

  // Wait for emission
  await wait(10);

  // Changes should still have been emitted to listeners
  assertTrue(changesCaught !== null, 'Changes should be emitted to listeners');
  assertEquals(changesCaught.count, 2, 'Emitted changes should match pending diff');

  LazyWatch.dispose(watched);
});

runner.test('should return empty object when no pending changes', () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data);

  const pendingDiff = LazyWatch.getPendingDiff(watched);
  assertEquals(pendingDiff, {}, 'Should return empty object when no pending changes');

  LazyWatch.dispose(watched);
});

runner.test('should return pending diff for nested objects', async () => {
  const data = { user: { name: 'Alice', age: 30 } };
  const watched = new LazyWatch(data);

  watched.user.name = 'Bob';
  watched.user.age = 31;

  const pendingDiff = LazyWatch.getPendingDiff(watched);
  assertTrue(pendingDiff.user !== undefined, 'Should have user changes');
  assertEquals(pendingDiff.user.name, 'Bob', 'Should track nested name change');
  assertEquals(pendingDiff.user.age, 31, 'Should track nested age change');

  LazyWatch.dispose(watched);
});

runner.test('should return pending diff for array changes', () => {
  const data = { items: [1, 2, 3] };
  const watched = new LazyWatch(data);

  watched.items[0] = 10;
  watched.items.push(4);

  const pendingDiff = LazyWatch.getPendingDiff(watched);
  assertTrue(pendingDiff.items !== undefined, 'Should have items changes');
  assertEquals(pendingDiff.items[0], 10, 'Should track array element change');
  assertEquals(pendingDiff.items[3], 4, 'Should track array push');

  LazyWatch.dispose(watched);
});

runner.test('should return a copy that does not affect internal diff', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data);
  let changesCaught = null;

  LazyWatch.on(watched, (changes) => {
    changesCaught = changes;
  });

  watched.count = 1;

  const pendingDiff = LazyWatch.getPendingDiff(watched);
  // Modify the returned diff
  pendingDiff.count = 999;
  pendingDiff.newProp = 'should not affect internal';

  // Wait for emission
  await wait(10);

  // Internal diff should not be affected
  assertEquals(changesCaught.count, 1, 'Internal diff should not be modified');
  assertTrue(changesCaught.newProp === undefined, 'Internal diff should not have new properties');

  LazyWatch.dispose(watched);
});

runner.test('should return pending diff after multiple changes', () => {
  const data = { a: 1, b: 2, c: 3 };
  const watched = new LazyWatch(data);

  watched.a = 10;
  watched.b = 20;
  delete watched.c;

  const pendingDiff = LazyWatch.getPendingDiff(watched);
  assertEquals(pendingDiff.a, 10, 'Should track first change');
  assertEquals(pendingDiff.b, 20, 'Should track second change');
  assertEquals(pendingDiff.c, null, 'Should track deletion as null');

  LazyWatch.dispose(watched);
});

runner.test('should throw error if instance is disposed', () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data);
  LazyWatch.dispose(watched);

  assertThrows(() => LazyWatch.getPendingDiff(watched), 'Should throw error for disposed instance');
});

// Usage examples
console.log('\n=== LazyWatch Usage Examples ===\n');

// Example 0: Throttled change detection
console.log('Example 0: Throttled change detection');
{
  const state = { count: 0 };
  const watched = new LazyWatch(state, { throttle: 50 });

  LazyWatch.on(watched, (changes) => {
    console.log('Throttled changes:', changes);
  });

  // Rapid changes will be batched
  watched.count = 1;
  watched.count = 2;
  watched.count = 3;
  // Only emits after 50ms with final changes

  setTimeout(() => LazyWatch.dispose(watched), 150);
}

// Example 1: Basic usage
console.log('Example 1: Basic change detection');
{
  const state = { count: 0, name: 'App' };
  const watched = new LazyWatch(state);

  LazyWatch.on(watched, (changes) => {
    console.log('Changes detected:', changes);
  });

  watched.count = 1;
  watched.name = 'MyApp';

  setTimeout(() => LazyWatch.dispose(watched), 100);
}

// Example 2: Nested objects
console.log('\nExample 2: Nested object tracking');
{
  const user = {
    profile: {
      name: 'Alice',
      settings: {
        theme: 'dark'
      }
    }
  };

  const watched = new LazyWatch(user);

  LazyWatch.on(watched, (changes) => {
    console.log('User changes:', changes);
  });

  watched.profile.settings.theme = 'light';

  setTimeout(() => LazyWatch.dispose(watched), 100);
}

// Example 3: Array operations
console.log('\nExample 3: Array tracking');
{
  const todos = {
    items: ['Task 1', 'Task 2']
  };

  const watched = new LazyWatch(todos);

  LazyWatch.on(watched, (changes) => {
    console.log('Todo changes:', changes);
  });

  watched.items.push('Task 3');
  watched.items[0] = 'Updated Task 1';

  setTimeout(() => LazyWatch.dispose(watched), 100);
}

// Example 4: State synchronization
console.log('\nExample 4: State synchronization');
{
  const localState = { user: { name: 'Alice', age: 30 } };
  const watched = new LazyWatch(localState);

  LazyWatch.on(watched, (changes) => {
    console.log('Syncing changes to server:', changes);
    // In real app: sendToServer(changes);
  });

  // Simulate receiving update from server
  setTimeout(() => {
    LazyWatch.patch(watched, { user: { name: 'Alice', age: 31, email: 'alice@example.com' } });
    console.log('State after patch:', watched);
  }, 50);

  setTimeout(() => LazyWatch.dispose(watched), 150);
}

// Example 5: Multiple listeners for different concerns
console.log('\nExample 5: Multiple listeners');
{
  const appState = { count: 0, history: [] };
  const watched = new LazyWatch(appState);

  // Logger listener
  LazyWatch.on(watched, (changes) => {
    console.log('[Logger]', new Date().toISOString(), changes);
  });

  // History listener
  LazyWatch.on(watched, (changes) => {
    console.log('[History] Recording changes...');
  });

  // Analytics listener
  LazyWatch.on(watched, (changes) => {
    console.log('[Analytics] Tracking user action');
  });

  watched.count++;

  setTimeout(() => LazyWatch.dispose(watched), 100);
}

// Run tests after a short delay to let examples run
setTimeout(() => {
  runner.run();
}, 300);