// timing.test.js - Throttle, debounce, getPendingDiff, pause/resume, and silent()
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, assertThrows, wait } from '../helpers.js';

export default function register(runner) {
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
}
