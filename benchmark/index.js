#!/usr/bin/env node
// index.js - Main benchmark suite runner

import {
  runCoreBenchmarks,
  runListenerBenchmarks,
  runThrottleDebounceBenchmarks,
  runLargeObjectBenchmarks
} from './core-benchmarks.js';

import {
  runMemoryBenchmarks,
  runMemoryLeakTest
} from './memory-benchmarks.js';

/**
 * Main benchmark suite
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                LazyWatch Benchmark Suite                       ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const args = process.argv.slice(2);
  const runAll = args.length === 0 || args.includes('--all');
  const runCore = runAll || args.includes('--core');
  const runListener = runAll || args.includes('--listener');
  const runThrottle = runAll || args.includes('--throttle');
  const runLarge = runAll || args.includes('--large');
  const runMemory = runAll || args.includes('--memory');
  const runLeak = runAll || args.includes('--leak');

  if (args.includes('--help')) {
    console.log('\nUsage: npm run benchmark [options]');
    console.log('\nOptions:');
    console.log('  --all        Run all benchmarks (default)');
    console.log('  --core       Run core performance benchmarks');
    console.log('  --listener   Run listener notification benchmarks');
    console.log('  --throttle   Run throttle/debounce benchmarks');
    console.log('  --large      Run large object benchmarks');
    console.log('  --memory     Run memory usage benchmarks');
    console.log('  --leak       Run memory leak detection test');
    console.log('  --help       Show this help message');
    console.log('\nExamples:');
    console.log('  npm run benchmark');
    console.log('  npm run benchmark --core');
    console.log('  npm run benchmark --core --memory');
    console.log('\nNote: Memory benchmarks require Node.js to be run with --expose-gc flag');
    console.log('      for accurate garbage collection measurements.\n');
    return;
  }

  try {
    if (runCore) {
      await runCoreBenchmarks();
    }

    if (runListener) {
      await runListenerBenchmarks();
    }

    if (runThrottle) {
      await runThrottleDebounceBenchmarks();
    }

    if (runLarge) {
      await runLargeObjectBenchmarks();
    }

    if (runMemory) {
      if (!global.gc) {
        console.log('\n⚠ Warning: GC not exposed. Run with --expose-gc flag for accurate results.');
        console.log('   Example: node --expose-gc benchmark/index.js --memory\n');
      }
      await runMemoryBenchmarks();
    }

    if (runLeak) {
      if (!global.gc) {
        console.log('\n⚠ Warning: GC not exposed. Run with --expose-gc flag for accurate results.');
        console.log('   Example: node --expose-gc benchmark/index.js --leak\n');
      }
      await runMemoryLeakTest();
    }

    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                   Benchmark Suite Complete                     ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

  } catch (error) {
    console.error('\n❌ Error running benchmarks:', error);
    process.exit(1);
  }
}

// Run the benchmark suite
main();
