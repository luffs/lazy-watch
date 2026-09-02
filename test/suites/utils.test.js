// utils.test.js - Public Utils helpers on edge inputs
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue } from '../helpers.js';

export default function register(runner) {
  runner.test('Utils.hasArrayMarker should accept any diff value, null and leaves included', () => {
    const { Utils } = LazyWatch;
    // null is the wire format's deletion marker and appears wherever a diff
    // value can, so a helper for inspecting diff values must not throw on it
    for (const value of [null, undefined, 0, 1, '', 'x', true, [], [1, 2], {}, { a: 1 }, { $length: 'two' }, { $splice: 'no' }]) {
      assertEquals(Utils.hasArrayMarker(value), false, `hasArrayMarker(${JSON.stringify(value)}) should be false`);
    }
    assertTrue(Utils.hasArrayMarker({ $length: 0 }), 'a pure truncation is marked');
    assertTrue(Utils.hasArrayMarker({ 1: 'b', $length: 2 }), 'an index fragment is marked');
    assertTrue(Utils.hasArrayMarker({ $splice: [[0, 1]] }), 'a splice list is a marker');
  });

  runner.test('Utils.isArrayDiff should reject non-objects without throwing', () => {
    const { Utils } = LazyWatch;
    for (const value of [null, undefined, 3, 'x', [1], { $length: 2, name: 'x' }]) {
      assertEquals(Utils.isArrayDiff(value), false, `isArrayDiff(${JSON.stringify(value)}) should be false`);
    }
    assertTrue(Utils.isArrayDiff({ 0: 'a', $length: 1 }));
  });
}
