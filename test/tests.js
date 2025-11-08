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
});

// Debounce tests
runner.test('should debounce emits with debounce option', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data, { debounce: 50 });
  let emitCount = 0;
  let lastChanges = null;

  LazyWatch.on(watched, (changes) => {
    emitCount++;
    lastChanges = changes;
  });

  // Make rapid changes - each should reset the debounce timer
  watched.count = 1;
  await wait(20);
  watched.count = 2;
  await wait(20);
  watched.count = 3;
  await wait(20);

  // At this point, no emit should have happened yet (only 60ms total, but timer keeps resetting)
  assertEquals(emitCount, 0, 'Should not have emitted yet');

  // Wait for debounce to complete
  await wait(60);

  // Now it should have emitted once with the final value
  assertEquals(emitCount, 1, 'Should emit once after debounce period');
  assertEquals(lastChanges.count, 3, 'Should have final value');

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
})
  
  
runner.test('should batch all changes in debounce window', async () => {
  const data = { a: 0, b: 0, c: 0 };
  const watched = new LazyWatch(data, { debounce: 50 });
  let emitCount = 0;
  let lastChanges = null;

  LazyWatch.on(watched, (changes) => {
    emitCount++;
    lastChanges = changes;
  });

  // Make multiple rapid changes
  watched.a = 1;
  watched.b = 2;
  watched.c = 3;

  // Wait less than debounce time
  await wait(30);

  // Should not have emitted yet
  assertEquals(emitCount, 0, 'Should not emit before debounce period');

  // Wait for debounce to complete
  await wait(30);

  // Should have emitted once with all changes
  assertEquals(emitCount, 1, 'Should emit once');
  assertTrue(lastChanges.a === 1 && lastChanges.b === 2 && lastChanges.c === 3, 'Should include all changes');

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
})
  
runner.test('should reset debounce timer on each change', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data, { debounce: 50 });
  let emitCount = 0;

  LazyWatch.on(watched, () => {
    emitCount++;
  });

  // Make changes every 30ms (less than debounce of 50ms)
  watched.count = 1;
  await wait(30);
  watched.count = 2;
  await wait(30);
  watched.count = 3;
  await wait(30);

  // Should not have emitted yet because timer keeps resetting
  assertEquals(emitCount, 0, 'Should not emit while changes keep coming');

  // Wait for full debounce period with no changes
  await wait(60);

  // Now should have emitted
  assertEquals(emitCount, 1, 'Should emit after debounce period with no changes');

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
});
  
runner.test('should prioritize debounce over throttle when both are set', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data, { throttle: 30, debounce: 50 });
  let emitCount = 0;
  let lastChanges = null;

  LazyWatch.on(watched, (changes) => {
    emitCount++;
    lastChanges = changes;
  });

  // With throttle only, first change would emit immediately
  // But with debounce, it should wait for the debounce period
  watched.count = 1;
  await wait(20);

  // Should not have emitted yet (debounce behavior)
  assertEquals(emitCount, 0, 'Should use debounce behavior, not throttle');

  // Make another change to reset debounce
  watched.count = 2;
  await wait(60);

  // Should have emitted once with final value
  assertEquals(emitCount, 1, 'Should emit once');
  assertEquals(lastChanges.count, 2);

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
})
  
runner.test('should allow multiple emits with debounce if changes are separated', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data, { debounce: 30 });
  const emitTimes = [];

  LazyWatch.on(watched, () => {
    emitTimes.push(Date.now());
  });

  // First change
  watched.count = 1;
  await wait(50); // Wait for debounce to complete

  // Second change after debounce
  watched.count = 2;
  await wait(50); // Wait for debounce to complete

  // Should have emitted twice
  assertTrue(emitTimes.length === 2, `Expected 2 emits, got ${emitTimes.length}`);

  LazyWatch.dispose(watched);
});

// Pause/Resume tests
runner.test('should pause event emissions', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data);
  let changesCaught = null;

  LazyWatch.on(watched, (changes) => {
    changesCaught = changes;
  });

  LazyWatch.pause(watched);
  watched.count = 1;

  await wait(50);

  assertEquals(changesCaught, null, 'Should not emit while paused');
  LazyWatch.dispose(watched);
});

runner.test('should resume event emissions', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data);
  let changesCaught = null;

  LazyWatch.on(watched, (changes) => {
    changesCaught = changes;
  });

  LazyWatch.pause(watched);
  watched.count = 1;

  await wait(50);
  assertEquals(changesCaught, null, 'Should not emit while paused');

  LazyWatch.resume(watched);

  await wait(50);
  assertEquals(changesCaught, { count: 1 }, 'Should emit pending changes on resume');
  LazyWatch.dispose(watched);
});

runner.test('should batch multiple changes while paused', async () => {
  const data = { a: 0, b: 0, c: 0 };
  const watched = new LazyWatch(data);
  let emitCount = 0;
  let lastChanges = null;

  LazyWatch.on(watched, (changes) => {
    emitCount++;
    lastChanges = changes;
  });

  LazyWatch.pause(watched);
  watched.a = 1;
  watched.b = 2;
  watched.c = 3;

  await wait(50);
  assertEquals(emitCount, 0, 'Should not emit while paused');

  LazyWatch.resume(watched);

  await wait(50);
  assertEquals(emitCount, 1, 'Should emit once on resume');
  assertEquals(lastChanges, { a: 1, b: 2, c: 3 }, 'Should include all pending changes');
  LazyWatch.dispose(watched);
});

runner.test('should report pause state correctly with isPaused', () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data);

  assertEquals(LazyWatch.isPaused(watched), false, 'Should not be paused initially');

  LazyWatch.pause(watched);
  assertEquals(LazyWatch.isPaused(watched), true, 'Should be paused after pause()');

  LazyWatch.resume(watched);
  assertEquals(LazyWatch.isPaused(watched), false, 'Should not be paused after resume()');

  LazyWatch.dispose(watched);
});

runner.test('should not emit if no changes while paused', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data);
  let emitCount = 0;

  LazyWatch.on(watched, () => {
    emitCount++;
  });

  LazyWatch.pause(watched);
  // No changes made

  LazyWatch.resume(watched);

  await wait(50);
  assertEquals(emitCount, 0, 'Should not emit if no changes were made');
  LazyWatch.dispose(watched);
});

runner.test('should handle pause/resume with nested objects', async () => {
  const data = { user: { name: 'Alice', age: 30 } };
  const watched = new LazyWatch(data);
  let changesCaught = null;

  LazyWatch.on(watched, (changes) => {
    changesCaught = changes;
  });

  LazyWatch.pause(watched);
  watched.user.name = 'Bob';
  watched.user.age = 31;

  await wait(50);
  assertEquals(changesCaught, null, 'Should not emit nested changes while paused');

  LazyWatch.resume(watched);

  await wait(50);
  assertEquals(changesCaught, { user: { name: 'Bob', age: 31 } }, 'Should emit all nested changes on resume');
  LazyWatch.dispose(watched);
});

runner.test('should work correctly with pause/resume and throttle', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data, { throttle: 50 });
  let emitCount = 0;
  let lastChanges = null;

  LazyWatch.on(watched, (changes) => {
    emitCount++;
    lastChanges = changes;
  });

  // First change - should emit immediately
  watched.count = 1;
  await wait(10);

  // Pause before second change
  LazyWatch.pause(watched);
  watched.count = 2;
  await wait(70); // Wait longer than throttle

  assertEquals(emitCount, 1, 'Should not emit second change while paused');

  // Resume and make another change
  LazyWatch.resume(watched);
  await wait(10);

  // Should emit the paused change immediately on resume
  assertEquals(emitCount, 2, 'Should emit paused change on resume');
  assertEquals(lastChanges, { count: 2 }, 'Should have the paused change');

  LazyWatch.dispose(watched);
});

runner.test('should work correctly with pause/resume and debounce', async () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data, { debounce: 50 });
  let emitCount = 0;
  let lastChanges = null;

  LazyWatch.on(watched, (changes) => {
    emitCount++;
    lastChanges = changes;
  });

  // Make a change
  watched.count = 1;

  // Pause before debounce completes
  await wait(20);
  LazyWatch.pause(watched);

  // Wait for debounce period to pass
  await wait(60);

  // Should not have emitted because we paused
  assertEquals(emitCount, 0, 'Should not emit while paused');

  // Resume - this should schedule an emit with debounce
  LazyWatch.resume(watched);

  // Wait for the debounce to complete
  await wait(60);

  // Should emit the pending change
  assertEquals(emitCount, 1, 'Should emit pending change on resume');
  assertEquals(lastChanges, { count: 1 }, 'Should have the pending change');

  LazyWatch.dispose(watched);
});

runner.test('should throw error for pause/resume on disposed instance', () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data);

  LazyWatch.dispose(watched);

  assertThrows(() => LazyWatch.pause(watched), 'Should throw error on pause after disposal');
  assertThrows(() => LazyWatch.resume(watched), 'Should throw error on resume after disposal');
  assertThrows(() => LazyWatch.isPaused(watched), 'Should throw error on isPaused after disposal');
});

// Silent method tests
runner.test('should execute callback silently and return diff', async () => {
  const data = { count: 0, name: '' };
  const watched = new LazyWatch(data);
  let eventFired = false;

  LazyWatch.on(watched, () => {
    eventFired = true;
  });

  const diff = LazyWatch.silent(watched, () => {
    watched.count = 1;
    watched.name = 'test';
  });

  assertEquals(diff, { count: 1, name: 'test' });
  await wait(50);
  assertTrue(!eventFired, 'No events should fire during silent execution');

  LazyWatch.dispose(watched);
});

runner.test('should force emit pending changes before silent execution', async () => {
  const data = { count: 0, name: '' };
  const watched = new LazyWatch(data);
  let changesCaught = null;

  LazyWatch.on(watched, (changes) => {
    changesCaught = changes;
  });

  watched.count = 1;

  const diff = LazyWatch.silent(watched, () => {
    watched.name = 'test';
  });

  assertEquals(diff, { name: 'test' });
  await wait(50);
  assertEquals(changesCaught, { count: 1 });

  LazyWatch.dispose(watched);
});

runner.test('should handle exceptions in silent callback', () => {
  const data = { count: 0 };
  const watched = new LazyWatch(data);

  try {
    LazyWatch.silent(watched, () => {
      watched.count = 1;
      throw new Error('Test error');
    });
  } catch (e) {
    assertTrue(e.message === 'Test error');
  }

  // Diff should still be consumed despite exception
  const pending = LazyWatch.getPendingDiff(watched);
  assertEquals(pending, {});

  LazyWatch.dispose(watched);
});

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

// Example 0b: Debounced change detection
console.log('Example 0b: Debounced change detection');
{
  const searchQuery = { text: '' };
  const watched = new LazyWatch(searchQuery, { debounce: 100 });

  LazyWatch.on(watched, (changes) => {
    console.log('Debounced search query:', changes);
    // In real app: performSearch(changes.text);
  });

  // Simulate user typing - each keystroke resets the debounce timer
  watched.text = 'h';
  setTimeout(() => { watched.text = 'he'; }, 20);
  setTimeout(() => { watched.text = 'hel'; }, 40);
  setTimeout(() => { watched.text = 'hell'; }, 60);
  setTimeout(() => { watched.text = 'hello'; }, 80);
  // Only emits 100ms after the last change (at 'hello')

  setTimeout(() => LazyWatch.dispose(watched), 250);
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