// helpers.js - Shared test runner, assertions, and convergence helpers
import { LazyWatch } from '../src/lazy-watch.js';

/**
 * Simple test runner
 */
export class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log('Running LazyWatch tests...\n');

    for (const { name, fn } of this.tests) {
      try {
        await fn();
        this.passed++;
        console.log(`✓ ${name}`);
      } catch (e) {
        this.failed++;
        console.error(`✗ ${name}`);
        console.error(`  ${e.message}`);
      }
    }

    console.log(`\n${this.passed} passed, ${this.failed} failed`);

    if (this.failed > 0 && typeof process !== 'undefined') {
      process.exitCode = 1;
    }
  }
}

export function assertEquals(actual, expected, message = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}

export function assertObjectEqual(actual, expected, message = '') {
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);

  if (actualKeys.length !== expectedKeys.length) {
    throw new Error(`${message}\nObjects have different number of keys.\nExpected keys: ${expectedKeys.length}\nActual keys: ${actualKeys.length}`);
  }

  for (const key of expectedKeys) {
    if (typeof expected[key] === 'object' && expected[key] !== null) {
      assertObjectEqual(actual[key], expected[key], `${message}\nNested object at key "${key}"`);
    } else if (actual[key] !== expected[key]) {
      throw new Error(`${message}\nKey "${key}" has different values.\nExpected: ${expected[key]}\nActual: ${actual[key]}`);
    }
  }
}

export function assertTrue(value, message = 'Expected true') {
  if (!value) {
    throw new Error(message);
  }
}

export function assertThrows(fn, message = 'Expected function to throw') {
  try {
    fn();
    throw new Error(message);
  } catch (e) {
    if (e.message === message) throw e;
  }
}

// Helper to wait for async operations
export function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Assert two LazyWatch trees have identical raw state
export function assertConverged(a, b, message = 'replicas should converge') {
  assertEquals(
    JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(a))),
    JSON.parse(JSON.stringify(LazyWatch.resolveIfProxy(b))),
    message
  );
}

// Applying the composed diff must equal applying the diffs in sequence
export function assertComposeEquivalent(initial, older, newer, message) {
  const sequential = LazyWatch.Utils.deepClone(initial);
  LazyWatch.patch(sequential, older);
  LazyWatch.patch(sequential, newer);

  const composed = LazyWatch.Utils.deepClone(initial);
  LazyWatch.patch(composed, LazyWatch.composeDiffs(older, newer));
  assertEquals(composed, sequential, message);
}
