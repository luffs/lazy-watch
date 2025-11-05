// benchmark-runner.js - Utility for running benchmarks with statistics

/**
 * Run a benchmark function multiple times and collect statistics
 * @param {string} name - Name of the benchmark
 * @param {Function} fn - Benchmark function to run
 * @param {Object} options - Configuration options
 * @param {number} options.iterations - Number of iterations to run (default: 1000)
 * @param {number} options.warmup - Number of warmup iterations (default: 100)
 * @returns {Object} Benchmark results with statistics
 */
export async function runBenchmark(name, fn, options = {}) {
  const iterations = options.iterations || 1000;
  const warmup = options.warmup || 100;

  // Warmup phase
  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  // Collect samples
  const samples = [];
  const startTime = Date.now();

  for (let i = 0; i < iterations; i++) {
    const iterStart = process.hrtime.bigint();
    await fn();
    const iterEnd = process.hrtime.bigint();
    samples.push(Number(iterEnd - iterStart) / 1000000); // Convert to milliseconds
  }

  const endTime = Date.now();
  const totalTime = endTime - startTime;

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
    opsPerSecond: (iterations / (totalTime / 1000)).toFixed(2)
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
    const result = await runBenchmark(benchmark.name, benchmark.fn, benchmark.options);
    results.push(result);
  }

  return results;
}

/**
 * Display benchmark results in a formatted table
 * @param {Array<Object>} results - Array of benchmark results
 */
export function displayResults(results) {
  console.log('\n=== Benchmark Results ===\n');

  // Calculate column widths
  const nameWidth = Math.max(20, ...results.map(r => r.name.length + 2));
  const numWidth = 12;

  // Header
  const header =
    'Name'.padEnd(nameWidth) +
    'Ops/sec'.padStart(numWidth) +
    'Mean (ms)'.padStart(numWidth) +
    'Median (ms)'.padStart(numWidth) +
    'P95 (ms)'.padStart(numWidth) +
    'P99 (ms)'.padStart(numWidth);

  console.log(header);
  console.log('='.repeat(header.length));

  // Results
  for (const result of results) {
    const row =
      result.name.padEnd(nameWidth) +
      result.opsPerSecond.padStart(numWidth) +
      result.stats.mean.padStart(numWidth) +
      result.stats.median.padStart(numWidth) +
      result.stats.p95.padStart(numWidth) +
      result.stats.p99.padStart(numWidth);

    console.log(row);
  }

  console.log('\n');
}

/**
 * Compare two benchmark results
 * @param {Object} baseline - Baseline benchmark result
 * @param {Object} comparison - Comparison benchmark result
 */
export function compare(baseline, comparison) {
  const baselineOps = parseFloat(baseline.opsPerSecond);
  const comparisonOps = parseFloat(comparison.opsPerSecond);

  const diff = ((comparisonOps - baselineOps) / baselineOps * 100).toFixed(2);
  const faster = comparisonOps > baselineOps;

  console.log(`\n${comparison.name} is ${Math.abs(diff)}% ${faster ? 'faster' : 'slower'} than ${baseline.name}`);
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
