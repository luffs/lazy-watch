// emit-scheduling.test.js - One live dispatch per batch: the first change
// in a batch schedules the microtask or throttle timer, later changes ride
// along. Counts the host calls the emitter makes.
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, wait } from '../helpers.js';

export default function register(runner) {
  // Wrap a global scheduling primitive to count calls for the duration of
  // fn (restored afterwards, even on failure); the wrapper still delegates
  async function counting(name, fn) {
    const original = globalThis[name];
    const counter = { calls: 0 };
    globalThis[name] = (...args) => { counter.calls++; return original(...args); };
    try {
      return await fn(counter);
    } finally {
      globalThis[name] = original;
    }
  }

  runner.test('a burst of changes should queue exactly one microtask', async () => {
    const watched = new LazyWatch({ a: 0, b: 0 });
    const diffs = [];
    LazyWatch.on(watched, d => diffs.push(d));
    await counting('queueMicrotask', async counter => {
      for (let i = 1; i <= 1000; i++) {
        watched.a = i;
        watched.b = -i;
      }
      assertEquals(counter.calls, 1, 'one microtask for the whole burst');
      await wait(5);
    });
    assertEquals(diffs, [{ a: 1000, b: -1000 }], 'the burst emits as one batch');
    LazyWatch.dispose(watched);
  });

  runner.test('changes after a flush should schedule a new microtask and the stale one should be a no-op', async () => {
    const watched = new LazyWatch({ n: 0 });
    const diffs = [];
    LazyWatch.on(watched, d => diffs.push(d));
    await counting('queueMicrotask', async counter => {
      watched.n = 1;
      LazyWatch.flush(watched);          // emits { n: 1 } synchronously; the queued microtask is now stale
      watched.n = 2;                     // must schedule again — the stale one must not be trusted
      watched.n = 3;
      assertEquals(counter.calls, 2, 'one microtask per batch, two batches');
      await wait(5);
    });
    assertEquals(diffs, [{ n: 1 }, { n: 3 }], 'both batches emitted once each');
    LazyWatch.dispose(watched);
  });

  runner.test('a throttled burst inside the window should arm exactly one timer', async () => {
    const watched = new LazyWatch({ n: 0 }, { throttle: 40 });
    const diffs = [];
    LazyWatch.on(watched, d => diffs.push(d));
    watched.n = 1;
    await wait(5);                       // first change emits immediately (window open)
    assertEquals(diffs, [{ n: 1 }]);
    await counting('setTimeout', async counter => {
      for (let i = 2; i <= 500; i++) watched.n = i;
      assertEquals(counter.calls, 1, 'one timer covers the whole burst');
      watched.n = 501;                   // still inside the window, still no new timer
      assertEquals(counter.calls, 1);
      await wait(60);
    });
    assertEquals(diffs, [{ n: 1 }, { n: 501 }], 'the burst coalesces into the one delayed emit');
    LazyWatch.dispose(watched);
  });

  runner.test('a throttled burst after the window should queue exactly one microtask', async () => {
    const watched = new LazyWatch({ n: 0 }, { throttle: 20 });
    const diffs = [];
    LazyWatch.on(watched, d => diffs.push(d));
    await counting('queueMicrotask', async counter => {
      for (let i = 1; i <= 300; i++) watched.n = i;
      assertEquals(counter.calls, 1, 'window open: one microtask, not one per change');
      await wait(5);
    });
    assertEquals(diffs, [{ n: 300 }]);
    LazyWatch.dispose(watched);
  });

  runner.test('flush and pause should release a pending throttle timer so the next change re-arms it', async () => {
    const watched = new LazyWatch({ n: 0 }, { throttle: 40 });
    const diffs = [];
    LazyWatch.on(watched, d => diffs.push(d));
    watched.n = 1;
    await wait(5);                       // emitted; window now closed
    watched.n = 2;                       // arms the timer
    LazyWatch.flush(watched);            // emits { n: 2 } and cancels the timer
    assertEquals(diffs, [{ n: 1 }, { n: 2 }]);
    watched.n = 3;                       // must arm a new timer, not assume the cancelled one
    await wait(60);
    assertEquals(diffs, [{ n: 1 }, { n: 2 }, { n: 3 }], 'the change after flush still emits');

    LazyWatch.pause(watched);
    watched.n = 4;
    await wait(60);
    assertEquals(diffs.length, 3, 'paused: nothing emitted');
    LazyWatch.resume(watched);
    await wait(60);
    assertEquals(diffs[3], { n: 4 }, 'resume emits the pending change');
    LazyWatch.dispose(watched);
  });

  runner.test('a listener writing during an emit should get its own next batch', async () => {
    const watched = new LazyWatch({ n: 0, echo: 0 });
    const diffs = [];
    LazyWatch.on(watched, d => {
      diffs.push(d);
      if (d.n !== undefined) watched.echo = d.n;  // a write from inside the emit
    });
    watched.n = 7;
    await wait(5);
    assertEquals(diffs, [{ n: 7 }, { echo: 7 }], 'the in-emit write schedules a fresh microtask');
    LazyWatch.dispose(watched);
  });

  runner.test('debounce should still reset per change and emit once after quiet', async () => {
    const watched = new LazyWatch({ n: 0 }, { debounce: 30 });
    const diffs = [];
    LazyWatch.on(watched, d => diffs.push(d));
    for (let i = 1; i <= 5; i++) {
      watched.n = i;
      await wait(10);                    // each change lands inside the previous window
    }
    assertEquals(diffs.length, 0, 'no emit while changes keep arriving');
    await wait(50);
    assertEquals(diffs, [{ n: 5 }], 'one emit after the quiet period');
    assertTrue(!LazyWatch.getPendingDiff(watched) || Object.keys(LazyWatch.getPendingDiff(watched)).length === 0);
    LazyWatch.dispose(watched);
  });
}
