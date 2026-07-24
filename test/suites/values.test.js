// values.test.js - Supported-value rules: collection/class-instance rejection, Date/RegExp leaves,
// prototype pollution and wire safety, and symbol-keyed local-only metadata
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, assertThrows, wait } from '../helpers.js';

export default function register(runner) {
  runner.test('should throw when watching a Map or Set directly', () => {
    assertThrows(() => new LazyWatch(new Map()));
    assertThrows(() => new LazyWatch(new Set()));
    assertThrows(() => new LazyWatch(new Date()));
  });

  runner.test('should throw when the initial object contains a collection', () => {
    assertThrows(() => new LazyWatch({ users: new Map() }));
    assertThrows(() => new LazyWatch({ deep: { nested: { ids: new Set() } } }));
    assertThrows(() => new LazyWatch({ bytes: new Uint8Array(4) }));
    assertThrows(() => new LazyWatch({ items: [new WeakMap()] }));
  });

  runner.test('should throw when assigning a collection into watched state', () => {
    const watched = new LazyWatch({});
    assertThrows(() => { watched.users = new Map(); });
    assertThrows(() => { watched.ids = new Set(); });
    assertThrows(() => { watched.buf = new ArrayBuffer(8); });
    // Nested inside an assigned object
    assertThrows(() => { watched.data = { deep: { users: new Map() } }; });
    LazyWatch.dispose(watched);
  });

  runner.test('should throw when patch/overwrite source (proxy or plain) contains a collection', () => {
    const watched = new LazyWatch({ a: 1 });
    assertThrows(() => LazyWatch.patch(watched, { users: new Map() }));
    assertThrows(() => LazyWatch.overwrite(watched, { deep: { ids: new Set() } }));
    assertThrows(() => LazyWatch.patch({}, { users: new Map() }));
    assertEquals(watched.a, 1, 'watched state should be untouched after rejection');
    LazyWatch.dispose(watched);
  });

  runner.test('rejection errors should name the type and offending path', () => {
    try {
      new LazyWatch({ deep: { users: new Map() } });
      throw new Error('should have thrown');
    } catch (e) {
      assertTrue(e instanceof TypeError, 'should be a TypeError');
      assertTrue(e.message.includes('Map'), `message should name the type: ${e.message}`);
      assertTrue(e.message.includes('deep.users'), `message should name the path: ${e.message}`);
    }
  });

  runner.test('Date and RegExp should work as leaf values', () => {
    const watched = new LazyWatch({
      when: new Date('2026-01-01'),
      pattern: /ab+c/
    });

    assertTrue(watched.when instanceof Date, 'value should still be a Date');
    assertEquals(watched.when.getFullYear(), 2026, 'Date methods should work through the proxy');
    assertTrue(watched.pattern.test('abbc'), 'RegExp.test should work through the proxy');

    LazyWatch.dispose(watched);
  });

  runner.test('replacing a leaf value should emit a diff', async () => {
    const watched = new LazyWatch({ when: new Date(0) });
    let changes = null;
    LazyWatch.on(watched, diff => { changes = diff; });

    watched.when = new Date('2026-01-01');
    await wait(10);

    assertTrue(changes !== null, 'replacing a Date should emit');
    assertTrue(changes.when instanceof Date, 'diff should contain the Date');
    assertEquals(changes.when.getFullYear(), 2026);
    LazyWatch.dispose(watched);
  });

  // --- Prototype pollution, wire-safety, and relay fixes ---

  runner.test('patch should reject prototype pollution attempts and leave state untouched', () => {
    const watched = new LazyWatch({ a: 1 });
    assertThrows(() => LazyWatch.patch(watched, JSON.parse('{"__proto__": {"polluted": true}}')));
    assertThrows(() => LazyWatch.patch(watched, JSON.parse('{"nested": {"__proto__": {"polluted": true}}}')));
    assertThrows(() => LazyWatch.patch(watched, JSON.parse('{"constructor": {"prototype": {"polluted": true}}}')));
    assertEquals({}.polluted, undefined, 'Object.prototype must not be polluted');
    assertEquals(watched.a, 1, 'state should be untouched');
    LazyWatch.dispose(watched);
  });

  runner.test('plain-object patch and overwrite should reject prototype pollution attempts', () => {
    const plain = { a: 1 };
    assertThrows(() => LazyWatch.patch(plain, JSON.parse('{"__proto__": {"polluted": true}}')));
    const watched = new LazyWatch({ a: 1 });
    assertThrows(() => LazyWatch.overwrite(watched, JSON.parse('{"a": 2, "__proto__": {"polluted": true}}')));
    assertEquals({}.polluted, undefined, 'Object.prototype must not be polluted');
    assertEquals(watched.a, 1, 'overwrite should be rejected atomically');
    LazyWatch.dispose(watched);
  });

  runner.test('should throw when writing reserved property names into watched state', () => {
    const watched = new LazyWatch({});
    assertThrows(() => { watched['__proto__'] = { polluted: true }; });
    assertThrows(() => { watched.data = JSON.parse('{"__proto__": {"x": 1}}'); });
    assertThrows(() => new LazyWatch(JSON.parse('{"constructor": {"x": 1}}')));
    assertEquals({}.polluted, undefined);
    LazyWatch.dispose(watched);
  });

  runner.test('assigning undefined should delete and sync as null', async () => {
    const src = new LazyWatch({ x: 1, y: 2 });
    const dst = new LazyWatch({ x: 1, y: 2 });
    let diff = null;
    LazyWatch.on(src, d => { diff = d; LazyWatch.patch(dst, JSON.parse(JSON.stringify(d))); });

    src.y = undefined;
    await wait(10);

    assertEquals(diff, { y: null }, 'undefined should be emitted as a null deletion');
    assertTrue(!('y' in LazyWatch.resolveIfProxy(src)), 'sender should delete the property');
    assertTrue(!('y' in LazyWatch.resolveIfProxy(dst)), 'receiver should delete the property');
    LazyWatch.dispose(src);
    LazyWatch.dispose(dst);
  });

  runner.test('should reject NaN and Infinity values', () => {
    const watched = new LazyWatch({ n: 1 });
    assertThrows(() => { watched.n = NaN; });
    assertThrows(() => { watched.n = Infinity; });
    assertThrows(() => { watched.data = { deep: -Infinity }; });
    assertThrows(() => new LazyWatch({ n: NaN }));
    assertThrows(() => LazyWatch.patch(watched, { n: NaN }));
    assertEquals(watched.n, 1, 'state should be untouched after rejection');
    LazyWatch.dispose(watched);
  });

  runner.test('deletions should propagate through a patch relay chain', async () => {
    const init = () => ({ x: 1, y: 2 });
    const A = new LazyWatch(init());
    const B = new LazyWatch(init());
    const C = new LazyWatch(init());
    LazyWatch.on(A, d => LazyWatch.patch(B, d));
    LazyWatch.on(B, d => LazyWatch.patch(C, d));

    delete A.x;
    await wait(20);

    assertEquals(Object.keys(LazyWatch.resolveIfProxy(B)), ['y'], 'B should apply the deletion');
    assertEquals(Object.keys(LazyWatch.resolveIfProxy(C)), ['y'], 'C should hear about the deletion from B');
    LazyWatch.dispose(A);
    LazyWatch.dispose(B);
    LazyWatch.dispose(C);
  });

  runner.test('truncating an array should drop stale pending diff indices', async () => {
    const watched = new LazyWatch({ items: [1, 2, 3] });
    let diff = null;
    LazyWatch.on(watched, d => { diff = d; });

    watched.items[4] = 'x';   // extends to length 5
    watched.items.length = 2; // truncate below the pending write
    await wait(10);

    assertTrue(!('4' in diff.items), 'stale index beyond new length should be dropped');
    assertEquals(diff.items.length, 2);
    LazyWatch.dispose(watched);
  });

  runner.test('getPendingDiff should preserve Date values', () => {
    const watched = new LazyWatch({ when: new Date(0) });
    watched.when = new Date('2026-01-01');
    const pending = LazyWatch.getPendingDiff(watched);
    assertTrue(pending.when instanceof Date, 'pending diff should keep Date instances');
    assertEquals(pending.when.getFullYear(), 2026);
    LazyWatch.dispose(watched);
  });

  // --- Symbol-keyed properties: local-only metadata ---

  runner.test('symbol-keyed writes should be stored but never emitted', async () => {
    const watched = new LazyWatch({ a: 1 });
    const SYM = Symbol('meta');
    let calls = 0;
    LazyWatch.on(watched, () => { calls++; });

    watched[SYM] = 'local-only';
    await wait(10);

    assertEquals(calls, 0, 'symbol write should not emit');
    assertEquals(watched[SYM], 'local-only', 'symbol value should be stored');
    LazyWatch.dispose(watched);
  });

  runner.test('symbol keys should never leak into emitted diffs', async () => {
    const watched = new LazyWatch({ a: 1 });
    const SYM = Symbol('meta');
    let diff = null;
    LazyWatch.on(watched, d => { diff = d; });

    watched[SYM] = 'local-only';
    watched.a = 2; // real change flushes the batch
    await wait(10);

    assertEquals(diff, { a: 2 });
    assertEquals(Object.getOwnPropertySymbols(diff).length, 0,
      'emitted diff must not carry symbol keys');
    LazyWatch.dispose(watched);
  });

  runner.test('symbol-keyed values should be exempt from validation and not proxied', async () => {
    const watched = new LazyWatch({ a: 1 });
    const SYM = Symbol('cache');
    let calls = 0;
    LazyWatch.on(watched, () => { calls++; });

    // Local-only values never reach the wire, so even a Map is fine here
    watched[SYM] = new Map([['k', 'v']]);
    assertEquals(watched[SYM].get('k'), 'v', 'Map methods should work (value not proxied)');

    // Mutating an object stored under a symbol is invisible to tracking
    const OBJ = Symbol('obj');
    watched[OBJ] = { nested: 1 };
    watched[OBJ].nested = 2;
    await wait(10);

    assertEquals(calls, 0, 'symbol-keyed values should never trigger emits');
    assertEquals(watched[OBJ].nested, 2);
    LazyWatch.dispose(watched);
  });

  runner.test('deleting a symbol-keyed property should not emit', async () => {
    const SYM = Symbol('meta');
    const watched = new LazyWatch({ a: 1 });
    watched[SYM] = 'x';
    let calls = 0;
    LazyWatch.on(watched, () => { calls++; });

    delete watched[SYM];
    await wait(10);

    assertEquals(calls, 0, 'symbol delete should not emit');
    assertEquals(watched[SYM], undefined);
    LazyWatch.dispose(watched);
  });

  // Non-plain object rejection tests

  runner.test('class instances should be rejected everywhere they enter watched state', () => {
    class Vec {
      constructor(x) { this.x = x; }
      mag() { return Math.abs(this.x); }
    }

    assertThrows(() => new LazyWatch(new Vec(1)), 'instance as the root should throw');
    assertThrows(() => new LazyWatch({ v: new Vec(1) }), 'instance in the initial object should throw');

    const watched = new LazyWatch({});
    assertThrows(() => { watched.v = new Vec(1); }, 'assignment should throw');
    assertEquals(LazyWatch.snapshot(watched), {}, 'rejected assignment must leave state untouched');
    assertThrows(() => LazyWatch.patch(watched, { v: new Vec(1) }), 'patch should throw');
    assertThrows(() => LazyWatch.overwrite(watched, { v: new Vec(1) }), 'overwrite should throw');
    assertThrows(() => LazyWatch.patch({}, { v: new Vec(1) }), 'plain-object patch should throw');

    try {
      watched.deep = { v: new Vec(1) };
      throw new Error('should have thrown');
    } catch (e) {
      assertTrue(e instanceof TypeError && e.message.includes('Vec') && e.message.includes('deep.v'),
        `error should name the class and path, got: ${e.message}`);
    }
    LazyWatch.dispose(watched);
  });

  runner.test('null-prototype objects should still be accepted and tracked', async () => {
    const bare = Object.create(null);
    bare.x = 1;
    const watched = new LazyWatch({ bare });
    let diff = null;
    LazyWatch.on(watched, d => { diff = d; });

    watched.bare.x = 2;
    await wait(10);
    assertEquals(diff, { bare: { x: 2 } }, 'null-prototype objects are plain data');
    LazyWatch.dispose(watched);
  });

  runner.test('class instances remain allowed under symbol keys (local-only escape hatch)', () => {
    class Session { constructor() { this.token = 't'; } }
    const watched = new LazyWatch({});
    const SESSION = Symbol('session');

    watched[SESSION] = new Session(); // must not throw
    assertTrue(watched[SESSION] instanceof Session,
      'symbol-keyed values are exempt from validation and never cloned');
    LazyWatch.dispose(watched);
  });
}
