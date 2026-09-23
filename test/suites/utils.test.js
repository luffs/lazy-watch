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

  runner.test('deepClone copies plain data by hand, holes and an own __proto__ key included, and falls back for the rest', () => {
    const { Utils } = LazyWatch;
    const sparse = [1, , 3];
    const copy = Utils.deepClone({ a: [sparse, { b: 'c' }], n: null });
    assertEquals(copy, { a: [[1, null, 3], { b: 'c' }], n: null });
    assertEquals(1 in copy.a[0], false, 'a hole stays a hole');
    const odd = JSON.parse('{"__proto__": {"x": 1}}');
    const oddCopy = Utils.deepClone(odd);
    assertEquals(Object.getPrototypeOf(oddCopy), Object.prototype, 'the key is data, not a prototype');
    assertEquals(Object.keys(oddCopy), ['__proto__']);
    assertEquals(({}).x, undefined);
    const cyclic = { name: 'loop' };
    cyclic.self = cyclic;
    const cyclicCopy = Utils.deepClone(cyclic);
    assertTrue(cyclicCopy.self === cyclicCopy && cyclicCopy !== cyclic, 'a cycle falls back to the general clone');
    const date = new Date(5);
    const dated = Utils.deepClone({ at: date });
    assertTrue(dated.at instanceof Date && dated.at.getTime() === 5 && dated.at !== date, 'so does a Date');
    let deep = {};
    const root = deep;
    for (let i = 0; i < 400; i++) deep = deep.next = {};
    assertTrue(Utils.deepClone(root).next.next !== undefined, 'and a nesting past the depth guard');
  });
}
