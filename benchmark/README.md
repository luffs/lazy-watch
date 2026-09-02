# LazyWatch Benchmark Suite

This directory contains a comprehensive benchmark suite for measuring the performance and memory characteristics of LazyWatch.

## Quick Start

Run all benchmarks:
```bash
npm run benchmark
```

Run specific benchmark categories:
```bash
npm run benchmark:core      # Core performance benchmarks
npm run benchmark:memory    # Memory usage benchmarks
```

## Benchmark Categories

### Core Performance Benchmarks (`--core`)

Measures the performance of fundamental LazyWatch operations:

- **Object Creation**: Comparison between plain objects and LazyWatch instances
- **Property Access**: Read performance for properties
- **Property Modification**: Write performance for properties
- **Nested Operations**: Performance with deeply nested objects
- **Array Operations**: Push, modification, and other array operations
- **Property Deletion**: Performance when deleting properties
- **Batched Changes**: Efficiency of batching multiple changes
- **Listener Management**: Adding and removing listeners
- **Patch/Overwrite**: Performance of patch and overwrite operations

### Listener Notification Benchmarks (`--listener`)

Measures the performance impact of multiple listeners:

- Notification with 1, 5, 10, and 50 listeners
- Helps understand scaling characteristics

### Throttle/Debounce Benchmarks (`--throttle`)

Compares performance with different emit strategies:

- No throttle/debounce (immediate emission)
- With throttle (rate limiting)
- With debounce (delayed batching)

### Large Object Benchmarks (`--large`)

Tests performance with large data structures:

- Objects with 100 and 1000 properties
- Arrays with 1000 items
- Helps identify scaling limitations

### Memory Benchmarks (`--memory`)

Measures memory usage for various scenarios:

- Single instance memory footprint
- Multiple instances (100 instances)
- Deeply nested objects
- Large arrays (1000 items)
- Impact of listeners (50 listeners)
- Memory cleanup after disposal
- Large objects (10,000 properties)
- Pending changes memory usage

### Memory Leak Detection (`--leak`)

Tests for memory leaks by creating and disposing 1000 instances and measuring memory delta.

## Command-Line Options

```bash
node --expose-gc ./benchmark/index.js [options]
```

### Options:

- `--all` - Run all benchmarks (default)
- `--core` - Run core performance benchmarks
- `--listener` - Run listener notification benchmarks
- `--throttle` - Run throttle/debounce benchmarks
- `--large` - Run large object benchmarks
- `--memory` - Run memory usage benchmarks
- `--leak` - Run memory leak detection test
- `--help` - Show help message

### Examples:

```bash
# Run all benchmarks
npm run benchmark

# Run only core benchmarks
npm run benchmark -- --core

# Run core and memory benchmarks
npm run benchmark -- --core --memory

# Run memory leak test
npm run benchmark -- --leak
```

## Understanding Results

### Performance Metrics

Each benchmark displays the following statistics:

- **Work / iteration**: What one timed iteration does (e.g. `1000 writes, then flush`); the timing columns are per iteration, the throughput column per op
- **Ops/sec (per op)**: Operations per second (higher is better). Benchmarks that batch work per iteration declare `workPerIteration`, so this is per access (or per created instance), not per iteration
- **Median (µs)**: 50th percentile time of one iteration
- **Mean (µs)**: Average time of one iteration
- **P95 / P99 (µs)**: 95th / 99th percentile time of one iteration

### Memory Metrics

Memory benchmarks show:

- **Heap Used**: Memory usage before and after operation
- **Diff**: Change in memory usage
- **Memory Freed**: Amount of memory reclaimed after disposal

### Interpreting Results

- **Lower times are better** for execution time metrics (Mean, Median, P95, P99)
- **Higher ops/sec is better** for throughput
- **Lower memory diff is better** for memory efficiency
- **More memory freed is better** for cleanup efficiency

## Technical Details

### Benchmark Infrastructure

The suite uses a custom benchmark runner (`benchmark-runner.js`) that:

- Performs warmup iterations to stabilize JIT compilation
- Collects multiple samples for statistical analysis
- Uses high-resolution timers (process.hrtime.bigint) for accurate measurements; ops/sec is derived from the summed per-iteration timings, so loop bookkeeping never counts as work
- Runs synchronous benchmark functions without an await (awaiting a plain value costs a microtask tick per iteration, which would dominate the fastest baselines); functions returning a promise are awaited
- Calculates mean, median, standard deviation, and percentiles

### Memory Measurements

Memory benchmarks require Node.js to be run with the `--expose-gc` flag to:

- Force garbage collection before measurements
- Get accurate memory usage snapshots
- Measure memory cleanup effectiveness

## Best Practices

1. **Close other applications** before running benchmarks to reduce noise
2. **Run multiple times** to account for system variations
3. **Use --expose-gc** for memory benchmarks to get accurate results
4. **Compare results** across different versions to track performance changes
5. **Monitor trends** rather than absolute numbers

## Adding New Benchmarks

To add a new benchmark:

1. Add it to the appropriate benchmark file (`core-benchmarks.js` or `memory-benchmarks.js`)
2. Use the `runBenchmark` or `runBenchmarkSuite` utilities
3. Follow the existing patterns for consistency

Example:
```javascript
{
  name: 'My new benchmark',
  fn: () => {
    // Benchmark code here
  },
  options: { iterations: 10000, warmup: 1000 }
}
```

## Performance Baselines

Expected performance characteristics (approximate, varies by hardware):

- **Object Creation**: ~50,000-100,000 ops/sec
- **Property Read**: ~500,000-1,000,000 ops/sec
- **Property Write**: ~100,000-200,000 ops/sec
- **Memory per Instance**: ~0.01-0.1 MB for simple objects

Note: These are rough guidelines. Actual performance depends on:
- Hardware specifications
- Node.js version
- Object complexity
- Number of listeners
- System load
