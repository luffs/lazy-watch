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

    if (this.failed > 0 && typeof process !== 'undefined') {
      process.exitCode = 1;
    }
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

runner.test('patchObject should revive array diffs when the target lacks the field', () => {
  const target = { existing: true };

  LazyWatch.patchObject(target, { items: { 0: 'a', length: 1 }, existing: false });

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

runner.test('should throw when watching a Map or Set directly', () => {
  assertThrows(() => new LazyWatch(new Map()));
  assertThrows(() => new LazyWatch(new Set()));
  assertThrows(() => new LazyWatch(new Date()));
});

runner.test('should throw when the initial object contains a collection', () => {
  assertThrows(() => new LazyWatch({ users: new Map() }));
  assertThrows(() => new LazyWatch({ deep: { nested: { ids: new Set() } } }));
  assertThrows(() => new LazyWatch({ bytes: new Uint8Array(4) }));
  assertThrows(() => new LazyWatch({ items: [new WeakMap()] }));
});

runner.test('should throw when assigning a collection into watched state', () => {
  const watched = new LazyWatch({});
  assertThrows(() => { watched.users = new Map(); });
  assertThrows(() => { watched.ids = new Set(); });
  assertThrows(() => { watched.buf = new ArrayBuffer(8); });
  // Nested inside an assigned object
  assertThrows(() => { watched.data = { deep: { users: new Map() } }; });
  LazyWatch.dispose(watched);
});

runner.test('should throw when patch/overwrite/patchObject source contains a collection', () => {
  const watched = new LazyWatch({ a: 1 });
  assertThrows(() => LazyWatch.patch(watched, { users: new Map() }));
  assertThrows(() => LazyWatch.overwrite(watched, { deep: { ids: new Set() } }));
  assertThrows(() => LazyWatch.patchObject({}, { users: new Map() }));
  assertEquals(watched.a, 1, 'watched state should be untouched after rejection');
  LazyWatch.dispose(watched);
});

runner.test('rejection errors should name the type and offending path', () => {
  try {
    new LazyWatch({ deep: { users: new Map() } });
    throw new Error('should have thrown');
  } catch (e) {
    assertTrue(e instanceof TypeError, 'should be a TypeError');
    assertTrue(e.message.includes('Map'), `message should name the type: ${e.message}`);
    assertTrue(e.message.includes('deep.users'), `message should name the path: ${e.message}`);
  }
});

runner.test('Date and RegExp should work as leaf values', () => {
  const watched = new LazyWatch({
    when: new Date('2026-01-01'),
    pattern: /ab+c/
  });

  assertTrue(watched.when instanceof Date, 'value should still be a Date');
  assertEquals(watched.when.getFullYear(), 2026, 'Date methods should work through the proxy');
  assertTrue(watched.pattern.test('abbc'), 'RegExp.test should work through the proxy');

  LazyWatch.dispose(watched);
});

runner.test('replacing a leaf value should emit a diff', async () => {
  const watched = new LazyWatch({ when: new Date(0) });
  let changes = null;
  LazyWatch.on(watched, diff => { changes = diff; });

  watched.when = new Date('2026-01-01');
  await wait(10);

  assertTrue(changes !== null, 'replacing a Date should emit');
  assertTrue(changes.when instanceof Date, 'diff should contain the Date');
  assertEquals(changes.when.getFullYear(), 2026);
  LazyWatch.dispose(watched);
});

// --- Compact $splice array ops ---

// Helper: assert two LazyWatch trees have identical raw state
function assertConverged(a, b, message = 'replicas should converge') {
  assertEquals(
    JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(a))),
    JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(b))),
    message
  );
}

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

runner.test('patchObject should apply $splice ops to plain objects', () => {
  const plain = { items: ['a', 'b', 'c'] };
  LazyWatch.patchObject(plain, { items: { $splice: [[1, 1, ['X', 'Y']]], length: 4 } });
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
      switch (rnd(7)) {
        case 0: src.items.push({ v: rnd(100) }); break;
        case 1: src.items.unshift({ v: rnd(100) }); break;
        case 2: if (len) src.items.shift(); break;
        case 3: if (len) src.items.splice(rnd(len), rnd(2) + 1); break;
        case 4: src.items.splice(rnd(len + 1), 0, { v: rnd(100) }); break;
        case 5: if (len) src.items[rnd(len)] = { v: rnd(100) }; break;
        case 6: if (len) { const el = src.items[rnd(len)]; if (el && typeof el === 'object') el.v = rnd(100); } break;
      }
    }
    await wait(5); // emit + patch between rounds
    assertConverged(src, dst, `round ${round}`);
  }

  LazyWatch.dispose(src);
  LazyWatch.dispose(dst);
});

// --- Prototype pollution, wire-safety, and relay fixes ---

runner.test('patch should reject prototype pollution attempts and leave state untouched', () => {
  const watched = new LazyWatch({ a: 1 });
  assertThrows(() => LazyWatch.patch(watched, JSON.parse('{"__proto__": {"polluted": true}}')));
  assertThrows(() => LazyWatch.patch(watched, JSON.parse('{"nested": {"__proto__": {"polluted": true}}}')));
  assertThrows(() => LazyWatch.patch(watched, JSON.parse('{"constructor": {"prototype": {"polluted": true}}}')));
  assertEquals({}.polluted, undefined, 'Object.prototype must not be polluted');
  assertEquals(watched.a, 1, 'state should be untouched');
  LazyWatch.dispose(watched);
});

runner.test('patchObject and overwrite should reject prototype pollution attempts', () => {
  const plain = { a: 1 };
  assertThrows(() => LazyWatch.patchObject(plain, JSON.parse('{"__proto__": {"polluted": true}}')));
  const watched = new LazyWatch({ a: 1 });
  assertThrows(() => LazyWatch.overwrite(watched, JSON.parse('{"a": 2, "__proto__": {"polluted": true}}')));
  assertEquals({}.polluted, undefined, 'Object.prototype must not be polluted');
  assertEquals(watched.a, 1, 'overwrite should be rejected atomically');
  LazyWatch.dispose(watched);
});

runner.test('should throw when writing reserved property names into watched state', () => {
  const watched = new LazyWatch({});
  assertThrows(() => { watched['__proto__'] = { polluted: true }; });
  assertThrows(() => { watched.data = JSON.parse('{"__proto__": {"x": 1}}'); });
  assertThrows(() => new LazyWatch(JSON.parse('{"constructor": {"x": 1}}')));
  assertEquals({}.polluted, undefined);
  LazyWatch.dispose(watched);
});

runner.test('assigning undefined should delete and sync as null', async () => {
  const src = new LazyWatch({ x: 1, y: 2 });
  const dst = new LazyWatch({ x: 1, y: 2 });
  let diff = null;
  LazyWatch.on(src, d => { diff = d; LazyWatch.patch(dst, JSON.parse(JSON.stringify(d))); });

  src.y = undefined;
  await wait(10);

  assertEquals(diff, { y: null }, 'undefined should be emitted as a null deletion');
  assertTrue(!('y' in LazyWatch.resolveIfProxy(src)), 'sender should delete the property');
  assertTrue(!('y' in LazyWatch.resolveIfProxy(dst)), 'receiver should delete the property');
  LazyWatch.dispose(src);
  LazyWatch.dispose(dst);
});

runner.test('should reject NaN and Infinity values', () => {
  const watched = new LazyWatch({ n: 1 });
  assertThrows(() => { watched.n = NaN; });
  assertThrows(() => { watched.n = Infinity; });
  assertThrows(() => { watched.data = { deep: -Infinity }; });
  assertThrows(() => new LazyWatch({ n: NaN }));
  assertThrows(() => LazyWatch.patch(watched, { n: NaN }));
  assertEquals(watched.n, 1, 'state should be untouched after rejection');
  LazyWatch.dispose(watched);
});

runner.test('deletions should propagate through a patch relay chain', async () => {
  const init = () => ({ x: 1, y: 2 });
  const A = new LazyWatch(init());
  const B = new LazyWatch(init());
  const C = new LazyWatch(init());
  LazyWatch.on(A, d => LazyWatch.patch(B, d));
  LazyWatch.on(B, d => LazyWatch.patch(C, d));

  delete A.x;
  await wait(20);

  assertEquals(Object.keys(LazyWatch.resolveIfProxy(B)), ['y'], 'B should apply the deletion');
  assertEquals(Object.keys(LazyWatch.resolveIfProxy(C)), ['y'], 'C should hear about the deletion from B');
  LazyWatch.dispose(A);
  LazyWatch.dispose(B);
  LazyWatch.dispose(C);
});

runner.test('truncating an array should drop stale pending diff indices', async () => {
  const watched = new LazyWatch({ items: [1, 2, 3] });
  let diff = null;
  LazyWatch.on(watched, d => { diff = d; });

  watched.items[4] = 'x';   // extends to length 5
  watched.items.length = 2; // truncate below the pending write
  await wait(10);

  assertTrue(!('4' in diff.items), 'stale index beyond new length should be dropped');
  assertEquals(diff.items.length, 2);
  LazyWatch.dispose(watched);
});

runner.test('getPendingDiff should preserve Date values', () => {
  const watched = new LazyWatch({ when: new Date(0) });
  watched.when = new Date('2026-01-01');
  const pending = LazyWatch.getPendingDiff(watched);
  assertTrue(pending.when instanceof Date, 'pending diff should keep Date instances');
  assertEquals(pending.when.getFullYear(), 2026);
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

// --- Symbol-keyed properties: local-only metadata ---

runner.test('symbol-keyed writes should be stored but never emitted', async () => {
  const watched = new LazyWatch({ a: 1 });
  const SYM = Symbol('meta');
  let calls = 0;
  LazyWatch.on(watched, () => { calls++; });

  watched[SYM] = 'local-only';
  await wait(10);

  assertEquals(calls, 0, 'symbol write should not emit');
  assertEquals(watched[SYM], 'local-only', 'symbol value should be stored');
  LazyWatch.dispose(watched);
});

runner.test('symbol keys should never leak into emitted diffs', async () => {
  const watched = new LazyWatch({ a: 1 });
  const SYM = Symbol('meta');
  let diff = null;
  LazyWatch.on(watched, d => { diff = d; });

  watched[SYM] = 'local-only';
  watched.a = 2; // real change flushes the batch
  await wait(10);

  assertEquals(diff, { a: 2 });
  assertEquals(Object.getOwnPropertySymbols(diff).length, 0,
    'emitted diff must not carry symbol keys');
  LazyWatch.dispose(watched);
});

runner.test('symbol-keyed values should be exempt from validation and not proxied', async () => {
  const watched = new LazyWatch({ a: 1 });
  const SYM = Symbol('cache');
  let calls = 0;
  LazyWatch.on(watched, () => { calls++; });

  // Local-only values never reach the wire, so even a Map is fine here
  watched[SYM] = new Map([['k', 'v']]);
  assertEquals(watched[SYM].get('k'), 'v', 'Map methods should work (value not proxied)');

  // Mutating an object stored under a symbol is invisible to tracking
  const OBJ = Symbol('obj');
  watched[OBJ] = { nested: 1 };
  watched[OBJ].nested = 2;
  await wait(10);

  assertEquals(calls, 0, 'symbol-keyed values should never trigger emits');
  assertEquals(watched[OBJ].nested, 2);
  LazyWatch.dispose(watched);
});

runner.test('deleting a symbol-keyed property should not emit', async () => {
  const SYM = Symbol('meta');
  const watched = new LazyWatch({ a: 1 });
  watched[SYM] = 'x';
  let calls = 0;
  LazyWatch.on(watched, () => { calls++; });

  delete watched[SYM];
  await wait(10);

  assertEquals(calls, 0, 'symbol delete should not emit');
  assertEquals(watched[SYM], undefined);
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