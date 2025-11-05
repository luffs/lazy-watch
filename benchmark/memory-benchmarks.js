// memory-benchmarks.js - Memory usage benchmarks for LazyWatch

import { LazyWatch } from '../src/lazy-watch.js';
import { measureMemory } from './benchmark-runner.js';

/**
 * Run memory usage benchmarks
 */
export async function runMemoryBenchmarks() {
  console.log('\n=== Memory Usage Benchmarks ===\n');

  // Benchmark 1: Single LazyWatch instance
  console.log('1. Single LazyWatch instance with simple object:');
  const mem1 = await measureMemory(() => {
    const watched = new LazyWatch({ a: 1, b: 2, c: 3 });
    // Keep reference to prevent GC during measurement
    global.__temp = watched;
  });
  console.log(`   Heap Used: ${mem1.heapUsed.before} MB -> ${mem1.heapUsed.after} MB (${mem1.heapUsed.diff} MB)`);
  delete global.__temp;

  // Benchmark 2: Multiple LazyWatch instances
  console.log('\n2. 100 LazyWatch instances:');
  const mem2 = await measureMemory(() => {
    const instances = [];
    for (let i = 0; i < 100; i++) {
      instances.push(new LazyWatch({ id: i, data: `item${i}` }));
    }
    global.__temp = instances;
  });
  console.log(`   Heap Used: ${mem2.heapUsed.before} MB -> ${mem2.heapUsed.after} MB (${mem2.heapUsed.diff} MB)`);
  console.log(`   Average per instance: ${(parseFloat(mem2.heapUsed.diff) / 100).toFixed(4)} MB`);
  delete global.__temp;

  // Benchmark 3: LazyWatch with nested objects
  console.log('\n3. LazyWatch with deeply nested object:');
  const mem3 = await measureMemory(() => {
    const data = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                data: 'deep'
              }
            }
          }
        }
      }
    };
    const watched = new LazyWatch(data);
    global.__temp = watched;
  });
  console.log(`   Heap Used: ${mem3.heapUsed.before} MB -> ${mem3.heapUsed.after} MB (${mem3.heapUsed.diff} MB)`);
  delete global.__temp;

  // Benchmark 4: LazyWatch with large array
  console.log('\n4. LazyWatch with 1000-item array:');
  const mem4 = await measureMemory(() => {
    const items = [];
    for (let i = 0; i < 1000; i++) {
      items.push({ id: i, value: `item${i}` });
    }
    const watched = new LazyWatch({ items });
    global.__temp = watched;
  });
  console.log(`   Heap Used: ${mem4.heapUsed.before} MB -> ${mem4.heapUsed.after} MB (${mem4.heapUsed.diff} MB)`);
  delete global.__temp;

  // Benchmark 5: LazyWatch with listeners
  console.log('\n5. LazyWatch with 50 listeners:');
  const mem5 = await measureMemory(() => {
    const watched = new LazyWatch({ count: 0 });
    for (let i = 0; i < 50; i++) {
      LazyWatch.on(watched, () => {});
    }
    global.__temp = watched;
  });
  console.log(`   Heap Used: ${mem5.heapUsed.before} MB -> ${mem5.heapUsed.after} MB (${mem5.heapUsed.diff} MB)`);
  delete global.__temp;

  // Benchmark 6: Memory cleanup after disposal
  console.log('\n6. Memory cleanup after disposal (100 instances):');
  const instances = [];
  for (let i = 0; i < 100; i++) {
    instances.push(new LazyWatch({ id: i }));
  }

  if (global.gc) global.gc();
  const beforeDispose = process.memoryUsage().heapUsed;

  // Dispose all instances
  for (const instance of instances) {
    LazyWatch.dispose(instance);
  }
  instances.length = 0;

  if (global.gc) global.gc();
  const afterDispose = process.memoryUsage().heapUsed;

  const freed = (beforeDispose - afterDispose) / 1024 / 1024;
  console.log(`   Heap Used: ${(beforeDispose / 1024 / 1024).toFixed(2)} MB -> ${(afterDispose / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   Memory freed: ${freed.toFixed(2)} MB`);

  // Benchmark 7: Large object with many properties
  console.log('\n7. LazyWatch with 10000 properties:');
  const mem7 = await measureMemory(() => {
    const data = {};
    for (let i = 0; i < 10000; i++) {
      data[`prop${i}`] = i;
    }
    const watched = new LazyWatch(data);
    global.__temp = watched;
  });
  console.log(`   Heap Used: ${mem7.heapUsed.before} MB -> ${mem7.heapUsed.after} MB (${mem7.heapUsed.diff} MB)`);
  delete global.__temp;

  // Benchmark 8: Pending changes memory
  console.log('\n8. Memory with pending changes (1000 changes):');
  const mem8 = await measureMemory(() => {
    const watched = new LazyWatch({ count: 0 });
    for (let i = 0; i < 1000; i++) {
      watched[`prop${i}`] = i;
    }
    global.__temp = watched;
  });
  console.log(`   Heap Used: ${mem8.heapUsed.before} MB -> ${mem8.heapUsed.after} MB (${mem8.heapUsed.diff} MB)`);
  delete global.__temp;

  console.log('\n');
}

/**
 * Run memory leak detection test
 */
export async function runMemoryLeakTest() {
  console.log('\n=== Memory Leak Detection ===\n');

  console.log('Creating and disposing 1000 instances...');

  if (global.gc) global.gc();
  const startMem = process.memoryUsage().heapUsed;

  for (let i = 0; i < 1000; i++) {
    const watched = new LazyWatch({ id: i, data: `item${i}` });
    LazyWatch.on(watched, () => {});
    watched.id = i * 2;
    LazyWatch.dispose(watched);
  }

  if (global.gc) global.gc();
  const endMem = process.memoryUsage().heapUsed;

  const diff = (endMem - startMem) / 1024 / 1024;
  console.log(`Start: ${(startMem / 1024 / 1024).toFixed(2)} MB`);
  console.log(`End: ${(endMem / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Difference: ${diff.toFixed(2)} MB`);

  if (diff < 5) {
    console.log('✓ No significant memory leak detected');
  } else {
    console.log('⚠ Possible memory leak (> 5MB increase after 1000 cycles)');
  }

  console.log('\n');
}
