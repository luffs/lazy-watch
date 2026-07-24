// scheduler.test.js - Custom emit scheduler (options.schedule)
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertThrows, wait } from '../helpers.js';

export default function register(runner) {
  // --- Custom scheduler (options.schedule) ---
  // A fake scheduler queues emit callbacks into `slots`; running them stands
  // in for the frame boundary (requestAnimationFrame etc.).

  function fakeScheduler() {
    const slots = [];
    return {
      schedule: cb => slots.push(cb),
      run: () => slots.splice(0).forEach(cb => cb()),
      get pending() { return slots.length; }
    };
  }

  runner.test('custom scheduler should defer emits to its slot and batch all changes into it', async () => {
    const sched = fakeScheduler();
    const src = new LazyWatch({ a: 0, b: 0 }, { schedule: sched.schedule });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.a = 1;
    src.b = 2;
    await wait(10); // well past any microtask — nothing may emit on its own
    assertEquals(diffs, [], 'no emit before the slot runs');
    assertEquals(sched.pending, 1, 'many changes share one slot');

    sched.run();
    assertEquals(diffs, [{ a: 1, b: 2 }], 'one batched emit inside the slot');
    LazyWatch.dispose(src);
  });

  runner.test('changes after an emitted slot should schedule a fresh slot', () => {
    const sched = fakeScheduler();
    const src = new LazyWatch({ a: 0 }, { schedule: sched.schedule });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.a = 1;
    sched.run();
    src.a = 2;
    assertEquals(sched.pending, 1, 'a new slot after the previous one fired');
    sched.run();
    assertEquals(diffs, [{ a: 1 }, { a: 2 }]);
    LazyWatch.dispose(src);
  });

  runner.test('flush should emit immediately and the stale slot should not double-emit', () => {
    const sched = fakeScheduler();
    const src = new LazyWatch({ a: 0 }, { schedule: sched.schedule });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.a = 1;
    LazyWatch.flush(src);
    assertEquals(diffs, [{ a: 1 }], 'flush bypasses the scheduler');

    sched.run(); // the outlived slot must be a no-op
    assertEquals(diffs, [{ a: 1 }], 'stale slot did not double-emit');

    // ...and must not have burned the machinery for later changes
    src.a = 2;
    sched.run();
    assertEquals(diffs, [{ a: 1 }, { a: 2 }]);
    LazyWatch.dispose(src);
  });

  runner.test('pause should invalidate a live slot; resume should schedule a new one', () => {
    const sched = fakeScheduler();
    const src = new LazyWatch({ a: 0 }, { schedule: sched.schedule });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.a = 1;
    LazyWatch.pause(src);
    sched.run();
    assertEquals(diffs, [], 'slot fired while paused emits nothing');

    src.a = 2; // still tracked while paused
    LazyWatch.resume(src);
    assertEquals(sched.pending, 1, 'resume schedules through the scheduler');
    sched.run();
    assertEquals(diffs, [{ a: 2 }]);
    LazyWatch.dispose(src);
  });

  runner.test('debounce with a custom scheduler should route the due emit through the slot', async () => {
    const sched = fakeScheduler();
    const src = new LazyWatch({ a: 0 }, { schedule: sched.schedule, debounce: 20 });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.a = 1;
    await wait(50); // debounce expired — the emit is due, but frame-aligned
    assertEquals(diffs, [], 'timer expiry alone must not emit');
    assertEquals(sched.pending, 1, 'due emit was handed to the scheduler');
    sched.run();
    assertEquals(diffs, [{ a: 1 }]);
    LazyWatch.dispose(src);
  });

  runner.test('throttle with a custom scheduler should route the immediate emit through the slot', () => {
    const sched = fakeScheduler();
    const src = new LazyWatch({ a: 0 }, { schedule: sched.schedule, throttle: 30 });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.a = 1; // outside the throttle window: due immediately, via the slot
    assertEquals(sched.pending, 1);
    sched.run();
    assertEquals(diffs, [{ a: 1 }]);
    LazyWatch.dispose(src);
  });

  runner.test('a listener mutating state inside a slot emit should get a fresh slot', () => {
    const sched = fakeScheduler();
    const src = new LazyWatch({ a: 0, other: 0 }, { schedule: sched.schedule });
    const diffs = [];
    let first = true;
    LazyWatch.on(src, d => {
      diffs.push(d);
      if (first) { first = false; src.other = 1; }
    });

    src.a = 1;
    sched.run();
    assertEquals(sched.pending, 1, 'mutation during emit schedules a new slot');
    sched.run();
    assertEquals(diffs, [{ a: 1 }, { other: 1 }]);
    LazyWatch.dispose(src);
  });

  runner.test('a slot firing after dispose should be a no-op', () => {
    const sched = fakeScheduler();
    const src = new LazyWatch({ a: 0 }, { schedule: sched.schedule });
    let emits = 0;
    LazyWatch.on(src, () => emits++);

    src.a = 1;
    LazyWatch.dispose(src);
    sched.run(); // must not throw or emit
    assertEquals(emits, 0);
  });

  runner.test('a non-function schedule option should throw', () => {
    assertThrows(() => new LazyWatch({}, { schedule: 16 }));
    assertThrows(() => new LazyWatch({}, { schedule: 'raf' }));
  });
}
