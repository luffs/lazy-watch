// core-benchmarks.js - Core performance benchmarks for LazyWatch

import { LazyWatch } from '../src/lazy-watch.js';
import { runBenchmarkSuite, displayResults, compare } from './benchmark-runner.js';

// Helper to wait for async operations
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run core performance benchmarks
 */
export async function runCoreBenchmarks() {
  console.log('\n=== Core Performance Benchmarks ===\n');

  // The read and write benchmarks operate on instances created once, so
  // that their ratio against the plain-object baseline measures the trap
  // cost of an access, not proxy construction against a literal. (The
  // creation benchmark covers construction and disposal.) Constructing per
  // iteration made the read ratio swing from ~7x locally to ~120x on a
  // shared CI runner, because the plain side was little more than loop
  // overhead while the LazyWatch side carried allocation and GC.
  //
  // Every ratio-guarded benchmark batches its work (READS, WRITES, and
  // CREATES per iteration) and declares workPerIteration and a work
  // description, so the table reports per-access (or per-instance)
  // throughput and says what one iteration did
  const KEYS = ['a', 'b', 'c'];
  const plainRead = { a: 1, b: 2, c: 3 };
  const watchedRead = new LazyWatch({ a: 1, b: 2, c: 3 });
  const plainWrite = { a: 1, b: 2, c: 3 };
  const watchedWrite = new LazyWatch({ a: 1, b: 2, c: 3 });
  // Writes cycle through values so every iteration records a real change
  // (an identical value is a no-op write), and the LazyWatch side flushes
  // once per iteration so the batch's emit is part of the measured write,
  // as it would be in an application (one emit per 1000 writes is ~1 us,
  // under 1% of the figure). Accesses rotate through the three keys so the
  // JIT cannot hoist the plain load out of the loop — with a literal key
  // it did, and the "baseline" was ~0.25 ns per read. The rotation makes
  // the store keyed rather than named, which costs a proxied write ~2.5x
  // over `watched.a = v` (the same code with literal keys measured ~55 ns
  // per write against ~140 ns here); the plain side pays the same shape,
  // so the ratio is fair, but per-op throughput here is a lower bound for
  // named-key application code. Each iteration performs enough accesses
  // that even the plain side takes microseconds and stands clear of the
  // two clock reads that bracket a sample (~0.1 us) — otherwise the
  // baseline measures the timer, and the ratio measures noise
  let tick = 0;
  const READS = 1000;
  const WRITES = 1000;
  // Creation is batched too: a single object literal takes a few
  // nanoseconds, below the ~80 ns a timed sample costs, so one per
  // iteration would measure the timer. The created objects are kept
  // reachable through `last` so the JIT cannot elide the plain literal
  const CREATES = 100;
  let last = null;

  const benchmarks = [
    {
      name: 'Plain object creation',
      fn: () => {
        for (let i = 0; i < CREATES; i++) {
          last = { a: 1, b: 2, c: 3, d: { e: 4 } };
        }
        return last;
      },
      options: { iterations: 2000, warmup: 200, workPerIteration: CREATES, work: `${CREATES} creates` }
    },
    {
      name: 'LazyWatch creation',
      fn: () => {
        for (let i = 0; i < CREATES; i++) {
          last = new LazyWatch({ a: 1, b: 2, c: 3, d: { e: 4 } });
          LazyWatch.dispose(last);
        }
        return last;
      },
      options: { iterations: 2000, warmup: 200, workPerIteration: CREATES, work: `${CREATES} creates + disposes` }
    },
    {
      name: 'Plain object property read',
      fn: () => {
        let sum = 0;
        for (let i = 0; i < READS; i++) sum += plainRead[KEYS[i % 3]];
        return sum;
      },
      options: { iterations: 2000, warmup: 200, workPerIteration: READS, work: `${READS} reads` }
    },
    {
      name: 'LazyWatch property read',
      fn: () => {
        let sum = 0;
        for (let i = 0; i < READS; i++) sum += watchedRead[KEYS[i % 3]];
        return sum;
      },
      options: { iterations: 2000, warmup: 200, workPerIteration: READS, work: `${READS} reads` }
    },
    {
      name: 'Plain object property write',
      fn: () => {
        for (let i = 0; i < WRITES; i++) plainWrite[KEYS[i % 3]] = ++tick;
      },
      options: { iterations: 2000, warmup: 200, workPerIteration: WRITES, work: `${WRITES} writes` }
    },
    {
      name: 'LazyWatch property write',
      fn: () => {
        for (let i = 0; i < WRITES; i++) watchedWrite[KEYS[i % 3]] = ++tick;
        LazyWatch.flush(watchedWrite);
      },
      options: { iterations: 2000, warmup: 200, workPerIteration: WRITES, work: `${WRITES} writes, then flush` }
    },
    {
      name: 'Nested object access',
      work: 'create, 1 nested read, dispose',
      fn: () => {
        const watched = new LazyWatch({ a: { b: { c: { d: 1 } } } });
        const val = watched.a.b.c.d;
        LazyWatch.dispose(watched);
      },
      options: { iterations: 10000, warmup: 1000 }
    },
    {
      name: 'Nested object write',
      work: 'create, 1 nested write, dispose',
      fn: () => {
        const watched = new LazyWatch({ a: { b: { c: { d: 1 } } } });
        watched.a.b.c.d = 100;
        LazyWatch.dispose(watched);
      },
      options: { iterations: 10000, warmup: 1000 }
    },
    {
      name: 'Array push operation',
      work: 'create, push 5 items, dispose',
      fn: () => {
        const watched = new LazyWatch({ items: [] });
        watched.items.push(1, 2, 3, 4, 5);
        LazyWatch.dispose(watched);
      },
      options: { iterations: 10000, warmup: 1000 }
    },
    {
      name: 'Array modification',
      work: 'create, 3 index writes, dispose',
      fn: () => {
        const watched = new LazyWatch({ items: [1, 2, 3, 4, 5] });
        watched.items[0] = 10;
        watched.items[2] = 30;
        watched.items[4] = 50;
        LazyWatch.dispose(watched);
      },
      options: { iterations: 10000, warmup: 1000 }
    },
    {
      name: 'Property deletion',
      work: 'create, 1 delete, dispose',
      fn: () => {
        const watched = new LazyWatch({ a: 1, b: 2, c: 3, d: 4, e: 5 });
        delete watched.c;
        LazyWatch.dispose(watched);
      },
      options: { iterations: 10000, warmup: 1000 }
    },
    {
      name: 'Batched changes (10 props)',
      work: 'create, 10 writes, dispose',
      fn: () => {
        const watched = new LazyWatch({
          a: 1, b: 2, c: 3, d: 4, e: 5,
          f: 6, g: 7, h: 8, i: 9, j: 10
        });
        watched.a = 100;
        watched.b = 200;
        watched.c = 300;
        watched.d = 400;
        watched.e = 500;
        watched.f = 600;
        watched.g = 700;
        watched.h = 800;
        watched.i = 900;
        watched.j = 1000;
        LazyWatch.dispose(watched);
      },
      options: { iterations: 10000, warmup: 1000 }
    },
    {
      name: 'Add listener',
      work: 'create, on(), dispose',
      fn: () => {
        const watched = new LazyWatch({ count: 0 });
        const listener = () => {};
        LazyWatch.on(watched, listener);
        LazyWatch.dispose(watched);
      },
      options: { iterations: 10000, warmup: 1000 }
    },
    {
      name: 'Add and remove listener',
      work: 'create, on(), off(), dispose',
      fn: () => {
        const watched = new LazyWatch({ count: 0 });
        const listener = () => {};
        LazyWatch.on(watched, listener);
        LazyWatch.off(watched, listener);
        LazyWatch.dispose(watched);
      },
      options: { iterations: 10000, warmup: 1000 }
    },
    {
      name: 'Patch operation',
      work: 'create, patch 2 keys, dispose',
      fn: () => {
        const watched = new LazyWatch({ a: 1, b: 2, c: 3 });
        LazyWatch.patch(watched, { a: 10, d: 4 });
        LazyWatch.dispose(watched);
      },
      options: { iterations: 10000, warmup: 1000 }
    },
    {
      name: 'Overwrite operation',
      work: 'create, overwrite 2 keys, dispose',
      fn: () => {
        const watched = new LazyWatch({ a: 1, b: 2, c: 3 });
        LazyWatch.overwrite(watched, { a: 10, d: 4 });
        LazyWatch.dispose(watched);
      },
      options: { iterations: 10000, warmup: 1000 }
    }
  ];

  const results = await runBenchmarkSuite(benchmarks);
  LazyWatch.dispose(watchedRead);
  LazyWatch.dispose(watchedWrite);
  displayResults(results);

  // Compare the ratio-guarded pairs (median, like the guard)
  console.log('\n=== Comparisons ===');
  compare(results[0], results[1]); // Plain vs LazyWatch creation
  compare(results[2], results[3]); // Plain vs LazyWatch read
  compare(results[4], results[5]); // Plain vs LazyWatch write

  return results;
}

/**
 * Run listener notification benchmarks
 */
export async function runListenerBenchmarks() {
  console.log('\n=== Listener Notification Benchmarks ===\n');

  // Wait deterministically for all listeners to be notified instead of using a fixed delay
  async function notifyWithNListeners(n) {
    const watched = new LazyWatch({ count: 0 });
    let notified = 0;
    const done = new Promise(resolve => {
      const handler = () => {
        notified++;
        if (notified === n) resolve();
      };
      for (let i = 0; i < n; i++) {
        LazyWatch.on(watched, handler);
      }
    });

    // Trigger a change that should notify all listeners once
    watched.count = 1;

    // Await until all listeners have been called
    await done;

    LazyWatch.dispose(watched);
  }

  const benchmarks = [
    {
      name: '1 listener notification',
      fn: async () => {
        await notifyWithNListeners(1);
      },
      options: { iterations: 1000, warmup: 100 }
    },
    {
      name: '10 listeners notification',
      fn: async () => {
        await notifyWithNListeners(10);
      },
      options: { iterations: 1000, warmup: 100 }
    },
    {
      name: '100 listeners notification',
      fn: async () => {
        await notifyWithNListeners(100);
      },
      options: { iterations: 500, warmup: 50 }
    },
    {
      name: '1000 listeners notification',
      fn: async () => {
        await notifyWithNListeners(1000);
      },
      options: { iterations: 500, warmup: 50 }
    },
  ];

  const results = await runBenchmarkSuite(benchmarks);
  displayResults(results);

  return results;
}

/**
 * Run throttle/debounce benchmarks
 */
export async function runThrottleDebounceBenchmarks() {
  console.log('\n=== Throttle/Debounce Benchmarks ===\n');

  // Helper to await a specific number of emissions
  function expectEmits(watched, expected) {
    return new Promise(resolve => {
      let count = 0;
      const handler = () => {
        count++;
        if (count >= expected) {
          LazyWatch.off(watched, handler);
          resolve();
        }
      };
      LazyWatch.on(watched, handler);
    });
  }

  // Throttle case: rapid writes every 10ms for ~100ms with throttle=50ms
  // Expected behavior (per implementation): emits around ~0ms, ~50ms, ~100ms => 3 emits
  async function throttleRapidWritesCase() {
    const watched = new LazyWatch({ count: 0 }, { throttle: 50 });
    const done = expectEmits(watched, 3);
    for (let i = 0; i < 10; i++) {
      watched.count = i;
      if (i < 9) await wait(10);
    }
    await done;
    LazyWatch.dispose(watched);
  }

  // Debounce case: burst of rapid writes (<50ms apart), expect single trailing emit ~50ms after last write
  async function debounceBurstCase() {
    const watched = new LazyWatch({ count: 0 }, { debounce: 50 });
    const done = expectEmits(watched, 1);
    for (let i = 0; i < 5; i++) {
      watched.count = i;
      if (i < 4) await wait(10);
    }
    await done; // resolves when the single debounced emit fires
    LazyWatch.dispose(watched);
  }

  const benchmarks = [
    {
      name: 'No throttle/debounce',
      fn: async () => {
        const watched = new LazyWatch({ count: 0 });
        const done = new Promise(resolve => {
          LazyWatch.on(watched, () => resolve());
        });
        for (let i = 0; i < 10; i++) {
          watched.count = i;
        }
        await done; // wait for the actual emission instead of sleeping
        LazyWatch.dispose(watched);
      },
      options: { iterations: 500, warmup: 50 }
    },
    {
      name: 'With throttle (50ms) — rapid writes',
      fn: async () => {
        await throttleRapidWritesCase();
      },
      options: { iterations: 50, warmup: 5 }
    },
    {
      name: 'With debounce (50ms) — burst',
      fn: async () => {
        await debounceBurstCase();
      },
      options: { iterations: 50, warmup: 5 }
    }
  ];

  const results = await runBenchmarkSuite(benchmarks);
  displayResults(results);

  return results;
}

/**
 * Run large object benchmarks
 */
export async function runLargeObjectBenchmarks() {
  console.log('\n=== Large Object Benchmarks ===\n');

  const benchmarks = [
    {
      name: 'Create large object (100 props)',
      fn: () => {
        const data = {};
        for (let i = 0; i < 100; i++) {
          data[`prop${i}`] = i;
        }
        const watched = new LazyWatch(data);
        LazyWatch.dispose(watched);
      },
      options: { iterations: 1000, warmup: 100 }
    },
    {
      name: 'Create large object (1000 props)',
      fn: () => {
        const data = {};
        for (let i = 0; i < 1000; i++) {
          data[`prop${i}`] = i;
        }
        const watched = new LazyWatch(data);
        LazyWatch.dispose(watched);
      },
      options: { iterations: 100, warmup: 10 }
    },
    {
      name: 'Modify large object (100 props)',
      fn: () => {
        const data = {};
        for (let i = 0; i < 100; i++) {
          data[`prop${i}`] = i;
        }
        const watched = new LazyWatch(data);
        for (let i = 0; i < 100; i++) {
          watched[`prop${i}`] = i * 2;
        }
        LazyWatch.dispose(watched);
      },
      options: { iterations: 1000, warmup: 100 }
    },
    {
      name: 'Large array operations (1000 items)',
      fn: () => {
        const watched = new LazyWatch({ items: [] });
        for (let i = 0; i < 1000; i++) {
          watched.items.push(i);
        }
        LazyWatch.dispose(watched);
      },
      options: { iterations: 100, warmup: 10 }
    }
  ];

  const results = await runBenchmarkSuite(benchmarks);
  displayResults(results);

  return results;
}
