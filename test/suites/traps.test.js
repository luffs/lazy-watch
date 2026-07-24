// traps.test.js - defineProperty / setPrototypeOf / preventExtensions traps
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertThrows, assertConverged, wait } from '../helpers.js';

export default function register(runner) {
  // --- defineProperty / setPrototypeOf / preventExtensions traps ---
  // Previously Object.defineProperty mutated the target with nothing
  // recorded or emitted (silent mirror desync), and setPrototypeOf could
  // swap the prototype of watched state.

  runner.test('defineProperty with a plain data descriptor should be tracked and emitted', async () => {
    const src = new LazyWatch({ a: 1 });
    const dst = new LazyWatch({ a: 1 });
    LazyWatch.on(src, d => LazyWatch.patch(dst, d));

    Object.defineProperty(src, 'b', { value: 2, enumerable: true, writable: true, configurable: true });
    await wait(5);
    assertEquals(LazyWatch.snapshot(src), { a: 1, b: 2 });
    assertConverged(src, dst);
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('defineProperty on an existing property should inherit its attributes and be tracked', async () => {
    const src = new LazyWatch({ a: 1 });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    // Attributes absent from the descriptor keep the live property's (all
    // true for normal assignments), so this equals a plain write
    Object.defineProperty(src, 'a', { value: 5 });
    await wait(5);
    assertEquals(src.a, 5);
    assertEquals(diffs, [{ a: 5 }]);
    LazyWatch.dispose(src);
  });

  runner.test('defineProperty should reject accessors and non-default attributes', () => {
    const src = new LazyWatch({ a: 1 });
    assertThrows(() => Object.defineProperty(src, 'b', { get() { return 1; } }));
    // On a NEW property, absent attributes default to false — untrackable
    assertThrows(() => Object.defineProperty(src, 'b', { value: 2 }));
    assertThrows(() => Object.defineProperty(src, 'b', { value: 2, enumerable: true, writable: true, configurable: false }));
    assertEquals(LazyWatch.snapshot(src), { a: 1 }, 'state untouched');
    LazyWatch.dispose(src);
  });

  runner.test('setPrototypeOf should be rejected; re-asserting the same prototype is a no-op', () => {
    const src = new LazyWatch({ a: 1 });
    assertThrows(() => Object.setPrototypeOf(src, { evil: true }));
    Object.setPrototypeOf(src, Object.prototype); // no-op, must not throw
    assertEquals(src.evil, undefined);
    LazyWatch.dispose(src);
  });

  runner.test('freeze/seal/preventExtensions should be rejected and leave the state trackable', async () => {
    const src = new LazyWatch({ a: 1 });
    assertThrows(() => Object.freeze(src));
    assertThrows(() => Object.seal(src));
    assertThrows(() => Object.preventExtensions(src));

    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));
    src.b = 2; // still extensible and tracked
    await wait(5);
    assertEquals(diffs, [{ b: 2 }]);
    LazyWatch.dispose(src);
  });

  runner.test('defineProperty with a symbol key should stay local-only', async () => {
    const src = new LazyWatch({ a: 1 });
    let emits = 0;
    LazyWatch.on(src, () => emits++);

    const KEY = Symbol('meta');
    // Symbol keys are exempt from the descriptor restrictions too
    Object.defineProperty(src, KEY, { value: 42, enumerable: false, writable: false, configurable: true });
    await wait(5);
    assertEquals(src[KEY], 42);
    assertEquals(emits, 0);
    LazyWatch.dispose(src);
  });
}
