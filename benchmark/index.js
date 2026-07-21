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

import { checkCoreRegressions } from './regression-guard.js';

/**
 * Main benchmark suite
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                LazyWatch Benchmark Suite                       ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const runAll = args.length === 0 || args.includes('--all');
  // The regression guard evaluates core results, so --check implies --core
  const runCore = runAll || args.includes('--core') || check;
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
    console.log('  --check      Fail (exit 1) when the performance regression guard');
    console.log('               trips; implies --core. Used by CI');
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
    let guardFailures = [];
    if (runCore) {
      const coreResults = await runCoreBenchmarks();
      // Always evaluated and printed; only fails the run under --check
      guardFailures = checkCoreRegressions(coreResults);
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

    if (check && guardFailures.length > 0) {
      console.error('❌ Performance regression guard failed:');
      for (const failure of guardFailures) {
        console.error(`  - ${failure}`);
      }
      console.error('\nIf the slowdown is an intentional trade-off, adjust the limit in');
      console.error('benchmark/regression-guard.js in the same commit and explain why.\n');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ Error running benchmarks:', error);
    process.exit(1);
  }
}

// Run the benchmark suite
main();
