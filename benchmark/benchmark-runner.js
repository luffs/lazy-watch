// benchmark-runner.js - Utility for running benchmarks with statistics

/**
 * Run a benchmark function multiple times and collect statistics.
 *
 * Each iteration is timed on its own with process.hrtime.bigint(), and
 * ops/sec is derived from the sum of those timings, so the loop's own
 * bookkeeping never counts as work. A synchronous benchmark function runs
 * without an await: awaiting a non-promise value costs a microtask tick
 * per iteration, which used to dominate the fast plain-object baselines
 * and made the ratio guards compare library work against loop overhead.
 * Functions that return a promise are awaited as before.
 * @param {string} name - Name of the benchmark
 * @param {Function} fn - Benchmark function to run
 * @param {Object} options - Configuration options
 * @param {number} options.iterations - Number of iterations to run (default: 1000)
 * @param {number} options.warmup - Number of warmup iterations (default: 100)
 * @param {number} options.workPerIteration - Operations one call of fn
 *   performs (default: 1). Ops/sec is scaled by it, so a function that
 *   batches many accesses to stand clear of the timer still reports
 *   per-access throughput
 * @param {string} options.work - What one iteration does, for the table's
 *   "Work / iteration" column (default: '1 op'), e.g. '1000 writes, then flush'
 * @returns {Object} Benchmark results: formatted `stats` (ms, 4 decimals),
 *   unrounded `raw` timings (ms) for the regression guard and the table,
 *   `work`, and `opsPerSecond` (per op, not per iteration)
 */
export async function runBenchmark(name, fn, options = {}) {
  const iterations = options.iterations || 1000;
  const warmup = options.warmup || 100;
  const workPerIteration = options.workPerIteration || 1;
  const work = options.work || '1 op';
  const isPromise = value => value !== null && typeof value === 'object' && typeof value.then === 'function';

  // Warmup phase
  for (let i = 0; i < warmup; i++) {
    const result = fn();
    if (isPromise(result)) await result;
  }

  // Collect samples
  const samples = [];
  let elapsedNs = 0n;

  for (let i = 0; i < iterations; i++) {
    const iterStart = process.hrtime.bigint();
    const result = fn();
    if (isPromise(result)) await result;
    const iterEnd = process.hrtime.bigint();
    const ns = iterEnd - iterStart;
    elapsedNs += ns;
    samples.push(Number(ns) / 1000000); // Convert to milliseconds
  }

  const totalTime = Number(elapsedNs) / 1000000; // Measured work only, in ms

  // Calculate statistics
  samples.sort((a, b) => a - b);
  const min = samples[0];
  const max = samples[samples.length - 1];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const p99 = samples[Math.floor(samples.length * 0.99)];

  // Calculate standard deviation
  const squaredDiffs = samples.map(x => Math.pow(x - mean, 2));
  const stdDev = Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / samples.length);

  return {
    name,
    work,
    iterations,
    totalTime,
    stats: {
      mean: mean.toFixed(4),
      median: median.toFixed(4),
      min: min.toFixed(4),
      max: max.toFixed(4),
      stdDev: stdDev.toFixed(4),
      p95: p95.toFixed(4),
      p99: p99.toFixed(4)
    },
    // Unrounded, for the regression guard: the formatted stats lose
    // sub-microsecond baselines to 4-decimal rounding
    raw: { mean, median, p95, p99 },
    opsPerSecond: (iterations * workPerIteration / (totalTime / 1000)).toFixed(2)
  };
}

/**
 * Run multiple benchmarks and display results
 * @param {Array<Object>} benchmarks - Array of benchmark configurations
 * @param {string} benchmarks[].name - Benchmark name
 * @param {Function} benchmarks[].fn - Benchmark function
 * @param {Object} benchmarks[].options - Benchmark options
 */
export async function runBenchmarkSuite(benchmarks) {
  console.log('\n=== Running Benchmark Suite ===\n');

  const results = [];

  for (const benchmark of benchmarks) {
    console.log(`Running: ${benchmark.name}...`);
    // A work description may sit on the benchmark itself or in its options
    const options = benchmark.work ? { ...benchmark.options, work: benchmark.work } : benchmark.options;
    const result = await runBenchmark(benchmark.name, benchmark.fn, options);
    results.push(result);
  }

  return results;
}

/**
 * Display benchmark results in a formatted table: what one iteration
 * does, throughput per op as a grouped integer, and per-iteration timings
 * in microseconds (every batched iteration lands between a microsecond
 * and a millisecond, the range that ms columns hide)
 * @param {Array<Object>} results - Array of benchmark results
 */
export function displayResults(results) {
  console.log('\n=== Benchmark Results ===\n');

  const ops = r => Math.round(parseFloat(r.opsPerSecond)).toLocaleString('en-US');
  const us = ms => (ms * 1000).toFixed(1);

  const nameWidth = Math.max(20, ...results.map(r => r.name.length + 2));
  const workWidth = Math.max(18, ...results.map(r => (r.work || '').length + 2));
  const opsWidth = Math.max(18, ...results.map(r => ops(r).length + 2));
  const numWidth = 12;

  const header =
    'Name'.padEnd(nameWidth) +
    'Work / iteration'.padEnd(workWidth) +
    'Ops/sec (per op)'.padStart(opsWidth) +
    'Median (µs)'.padStart(numWidth) +
    'Mean (µs)'.padStart(numWidth) +
    'P95 (µs)'.padStart(numWidth) +
    'P99 (µs)'.padStart(numWidth);

  console.log(header);
  console.log('='.repeat(header.length));

  for (const result of results) {
    const raw = result.raw || {
      mean: parseFloat(result.stats.mean), median: parseFloat(result.stats.median),
      p95: parseFloat(result.stats.p95), p99: parseFloat(result.stats.p99)
    };
    console.log(
      result.name.padEnd(nameWidth) +
      (result.work || '1 op').padEnd(workWidth) +
      ops(result).padStart(opsWidth) +
      us(raw.median).padStart(numWidth) +
      us(raw.mean).padStart(numWidth) +
      us(raw.p95).padStart(numWidth) +
      us(raw.p99).padStart(numWidth)
    );
  }

  console.log('\n');
}

/**
 * Compare two benchmark results by median per-iteration time, the same
 * figure the regression guard uses. (A "99.3% slower" line says nothing
 * once the gap is above 10x; the multiple does.)
 * @param {Object} baseline - Baseline benchmark result
 * @param {Object} comparison - Comparison benchmark result
 */
export function compare(baseline, comparison) {
  const median = r => (r.raw ? r.raw.median : parseFloat(r.stats.median));
  const ratio = median(comparison) / median(baseline);
  const [a, b, word] = ratio >= 1 ? [ratio, 1, 'slower'] : [1 / ratio, 1, 'faster'];
  void b;
  console.log(`\n${comparison.name}: median ${a.toFixed(1)}x ${word} than ${baseline.name}`);
}

/**
 * Measure memory usage of a function
 * @param {Function} fn - Function to measure
 * @returns {Object} Memory usage statistics
 */
export async function measureMemory(fn) {
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }

  const memBefore = process.memoryUsage();

  await fn();

  if (global.gc) {
    global.gc();
  }

  const memAfter = process.memoryUsage();

  return {
    heapUsed: {
      before: (memBefore.heapUsed / 1024 / 1024).toFixed(2),
      after: (memAfter.heapUsed / 1024 / 1024).toFixed(2),
      diff: ((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(2)
    },
    external: {
      before: (memBefore.external / 1024 / 1024).toFixed(2),
      after: (memAfter.external / 1024 / 1024).toFixed(2),
      diff: ((memAfter.external - memBefore.external) / 1024 / 1024).toFixed(2)
    }
  };
}
