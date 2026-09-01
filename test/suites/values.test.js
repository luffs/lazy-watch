// values.test.js - Supported-value rules: collection/class-instance rejection, non-JSON leaf
// rejection (Date, RegExp, bigint, symbol, function), prototype pollution and wire safety,
// and symbol-keyed local-only metadata
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, assertThrows, assertConverged, wait } from '../helpers.js';

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

  // --- Values JSON cannot carry faithfully ---
  // Date arrives as a string (and the sender drifts to a string on echo),
  // RegExp as {}, functions and symbols vanish, and JSON.stringify throws
  // on bigint — every one of them a silent mirror desync or a crash inside
  // the listener. Rejected like NaN, at every entry point.
  const NON_JSON_VALUES = [
    ['Date', new Date('2026-01-01')],
    ['RegExp', /ab+c/],
    ['bigint', 10n],
    ['symbol', Symbol('s')],
    ['function', () => 1]
  ];

  runner.test('Date, RegExp, bigint, symbol, and function values should be rejected at every entry point', () => {
    const watched = new LazyWatch({ a: 1, list: ['x'] });
    let emits = 0;
    LazyWatch.on(watched, () => emits++);
    for (const [name, value] of NON_JSON_VALUES) {
      assertThrows(() => new LazyWatch({ v: value }), `constructor should reject ${name}`);
      assertThrows(() => new LazyWatch({ deep: { list: [value] } }), `constructor should reject nested ${name}`);
      assertThrows(() => { watched.v = value; }, `assignment should reject ${name}`);
      assertThrows(() => { watched.v = { deep: value }; }, `nested assignment should reject ${name}`);
      assertThrows(() => watched.list.push(value), `push should reject ${name}`);
      assertThrows(() => watched.list.unshift(value), `unshift should reject ${name}`);
      assertThrows(() => LazyWatch.patch(watched, { v: value }), `patch should reject ${name}`);
      assertThrows(() => LazyWatch.overwrite(watched, { a: 1, v: value }), `overwrite should reject ${name}`);
      assertThrows(() => LazyWatch.patch({}, { v: value }), `plain patch should reject ${name}`);
      assertThrows(() => LazyWatch.composeDiffs({ v: value }, {}), `composeDiffs should reject ${name}`);
    }
    assertEquals(LazyWatch.snapshot(watched), { a: 1, list: ['x'] }, 'state must be untouched');
    assertEquals(LazyWatch.getPendingDiff(watched), {}, 'nothing may be recorded');
    assertEquals(emits, 0);
    LazyWatch.dispose(watched);
  });

  runner.test('non-JSON value rejections should name the type and path', () => {
    for (const [name, value] of NON_JSON_VALUES) {
      try {
        new LazyWatch({ deep: { v: value } });
        throw new Error('should have thrown');
      } catch (e) {
        assertTrue(e instanceof TypeError, `${name}: should be a TypeError`);
        assertTrue(e.message.includes(name), `${name}: message should name the type: ${e.message}`);
        assertTrue(e.message.includes('deep.v'), `${name}: message should name the path: ${e.message}`);
      }
    }
  });

  runner.test('JSON-safe leaf replacements should still emit and keep their type', async () => {
    const watched = new LazyWatch({ when: 0, flag: false, label: '' });
    let changes = null;
    LazyWatch.on(watched, diff => { changes = diff; });

    watched.when = Date.UTC(2026, 0, 1); // the wire-safe form of a Date
    watched.flag = true;
    watched.label = 'x';
    await wait(10);

    assertEquals(changes, { when: Date.UTC(2026, 0, 1), flag: true, label: 'x' });
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

  // --- Wire-format reserved keys ($splice, $length) that state may not contain ---

  runner.test('should throw when writing the reserved wire key "$splice" into watched state', () => {
    const watched = new LazyWatch({ config: {}, items: [] });
    assertThrows(() => { watched.$splice = 'data'; }, 'direct assignment should throw');
    assertThrows(() => { watched.config.$splice = 'data'; }, 'nested assignment should throw');
    assertThrows(() => { watched.config = { $splice: 'data' }; }, 'inside an assigned value should throw');
    assertThrows(() => { watched.config = { deep: { $splice: 1 } }; }, 'deeply nested should throw');
    assertThrows(
      () => Object.defineProperty(watched, '$splice', {
        value: 1, enumerable: true, writable: true, configurable: true
      }),
      'defineProperty should throw'
    );
    assertThrows(() => { watched.items.splice(0, 0, { $splice: 1 }); }, 'a spliced-in item should throw');
    assertThrows(() => { watched.items.push({ $splice: 1 }); }, 'a pushed item should throw');
    assertThrows(() => new LazyWatch({ $splice: 'data' }), 'the initial object should throw');
    assertThrows(() => new LazyWatch({ deep: { $splice: 'data' } }), 'nested in the initial object should throw');
    assertEquals(LazyWatch.resolveIfProxy(watched), { config: {}, items: [] }, 'state should be untouched');
    LazyWatch.dispose(watched);
  });

  runner.test('the "$splice" rejection should name the key and the path', () => {
    const watched = new LazyWatch({});
    try {
      watched.deep = { nested: { $splice: 1 } };
      throw new Error('should have thrown');
    } catch (e) {
      assertTrue(e instanceof TypeError, 'should be a TypeError');
      assertTrue(e.message.includes('$splice'), `message should name the key: ${e.message}`);
      assertTrue(e.message.includes('deep.nested'), `message should name the path: ${e.message}`);
    }
    LazyWatch.dispose(watched);
  });

  runner.test('"$splice" should still be accepted as a structural op inside a diff', async () => {
    // The state-side rejection must not break the wire format that owns the key
    const watched = new LazyWatch({ items: ['b'] });
    const mirror = new LazyWatch({ items: ['b'] });
    LazyWatch.on(watched, d => LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d))));

    LazyWatch.patch(watched, { items: { $splice: [[0, 0, ['a']]], $length: 2 } });
    await wait(10);

    assertEquals(LazyWatch.resolveIfProxy(watched.items), ['a', 'b'], 'ops should apply');
    assertConverged(watched, mirror, 'relayed ops should converge');

    // The compact form must still be emitted by senders, and compose
    const emitted = [];
    const src = new LazyWatch({ items: ['b'] });
    LazyWatch.on(src, d => emitted.push(d));
    src.items.unshift('a');
    await wait(10);
    assertEquals(emitted[0], { items: { $splice: [[0, 0, ['a']]], $length: 2 } }, 'senders still emit $splice');
    assertEquals(
      LazyWatch.composeDiffs({ items: { $splice: [[0, 0, ['a']]], $length: 2 } }, { items: { $splice: [[2, 0, ['c']]], $length: 3 } }),
      { items: { $splice: [[0, 0, ['a']], [2, 0, ['c']]], $length: 3 } },
      'composeDiffs still accepts $splice'
    );

    // A plain-object mirror applies ops too
    const plain = { items: ['b'] };
    LazyWatch.patch(plain, { items: { $splice: [[0, 0, ['a']]], $length: 2 } });
    assertEquals(plain.items, ['a', 'b'], 'plain targets still apply ops');

    LazyWatch.dispose(watched);
    LazyWatch.dispose(mirror);
    LazyWatch.dispose(src);
  });

  runner.test('should throw when writing the reserved wire key "$length" into watched state', () => {
    // `$length` marks array lengths in fragments, so receivers consume it
    // on arrays and drop it everywhere else — as data it could never arrive
    const watched = new LazyWatch({ config: {}, items: [] });
    assertThrows(() => { watched.$length = 5; }, 'direct assignment should throw');
    assertThrows(() => { watched.config.$length = 5; }, 'nested assignment should throw');
    assertThrows(() => { watched.config = { $length: 5 }; }, 'inside an assigned value should throw');
    assertThrows(() => { watched.config = { deep: { $length: 5 } }; }, 'deeply nested should throw');
    assertThrows(
      () => Object.defineProperty(watched, '$length', {
        value: 5, enumerable: true, writable: true, configurable: true
      }),
      'defineProperty should throw'
    );
    assertThrows(() => { watched.items.splice(0, 0, { $length: 5 }); }, 'a spliced-in item should throw');
    assertThrows(() => { watched.items.push({ $length: 5 }); }, 'a pushed item should throw');
    assertThrows(() => new LazyWatch({ $length: 5 }), 'the initial object should throw');
    assertThrows(() => new LazyWatch({ deep: { $length: 5 } }), 'nested in the initial object should throw');
    assertEquals(LazyWatch.resolveIfProxy(watched), { config: {}, items: [] }, 'state should be untouched');
    LazyWatch.dispose(watched);
  });

  runner.test('array-like objects should be ordinary, syncable data', async () => {
    // With `$length` marking fragments, a plain `length` key is never wire
    // vocabulary: objects that look like arrays are legal state and arrive
    // on mirrors as the objects they are
    const src = new LazyWatch({});
    const mirror = new LazyWatch({});
    LazyWatch.on(src, d => LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d))));

    src.weird = { 0: 'x', length: 2 };
    src.dimensions = { length: 5 };
    src.mixed = { 0: 'a', name: 'x', length: 1 };
    src.real = ['a', 'b'];
    await wait(10);

    assertConverged(src, mirror, 'array-like objects should sync as objects');
    assertTrue(!Array.isArray(LazyWatch.resolveIfProxy(mirror.weird)),
      'the mirror should hold an object, not a revived array');

    // The incremental route converges too: building the shape key by key
    // (this desynced mirrors when `length` doubled as the fragment marker)
    src.built = { 0: 'x' };
    src.built.length = 2;
    await wait(10);
    assertConverged(src, mirror, 'incrementally built array-likes should sync');
    assertTrue(!Array.isArray(LazyWatch.resolveIfProxy(mirror.built)),
      'the mirror should hold the built object, not an array');

    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  runner.test('array fragments must stay applicable as diffs under the reserved-key rules', async () => {
    // The reserved keys are rejected from state only: fragments are the
    // merge form and must keep working, including revival where the
    // receiver has no field
    const receiver = new LazyWatch({});
    LazyWatch.patch(receiver, { items: { 1: 'b', $length: 2 } });
    assertTrue(Array.isArray(LazyWatch.resolveIfProxy(receiver.items)), 'fragment should revive into an array');

    const merging = new LazyWatch({ items: ['a', 'b'] });
    LazyWatch.patch(merging, { items: { 1: 'B', $length: 2 } });
    assertEquals(LazyWatch.resolveIfProxy(merging.items), ['a', 'B'], 'fragment should merge into an array');

    // Inverse diffs carry index-keyed fragments too
    const undoable = new LazyWatch({ items: ['a', 'b'] }, { inverse: true });
    let inverse = null;
    LazyWatch.on(undoable, (d, inv) => { inverse = inv; });
    undoable.items[1] = 'B';
    await wait(10);
    LazyWatch.patch(undoable, inverse);
    assertEquals(LazyWatch.resolveIfProxy(undoable.items), ['a', 'b'], 'inverse should still apply');

    LazyWatch.dispose(receiver);
    LazyWatch.dispose(merging);
    LazyWatch.dispose(undoable);
  });

  runner.test('a rejected splice item should leave the array untouched on every recording path', () => {
    // Items are validated before any branch runs. The compact path always
    // did this; the two fallback paths ran the native method straight away,
    // so the shift writes landed before the bad item was rejected
    // (['b','c'] came out as ['b','b','c']).
    const compact = new LazyWatch({ items: ['b', 'c'] });
    assertThrows(() => { compact.items.splice(0, 0, new Map()); });
    assertEquals(LazyWatch.resolveIfProxy(compact.items), ['b', 'c'], 'compact path');

    // Fallback 1: inverse recording disables compact $splice ops
    const inverse = new LazyWatch({ items: ['b', 'c'] }, { inverse: true });
    assertThrows(() => { inverse.items.splice(0, 0, new Map()); });
    assertEquals(LazyWatch.resolveIfProxy(inverse.items), ['b', 'c'], 'inverse fallback');
    assertThrows(() => { inverse.items.unshift({ $length: 1 }); });
    assertEquals(LazyWatch.resolveIfProxy(inverse.items), ['b', 'c'], 'inverse fallback, unshift');

    // Fallback 2: pending index writes dirty the array's diff node
    const dirty = new LazyWatch({ items: ['b', 'c'] });
    dirty.items[1] = 'C';
    assertThrows(() => { dirty.items.splice(0, 0, new Map()); });
    assertEquals(LazyWatch.resolveIfProxy(dirty.items), ['b', 'C'], 'dirty-node fallback');

    LazyWatch.dispose(compact);
    LazyWatch.dispose(inverse);
    LazyWatch.dispose(dirty);
  });

  runner.test('reserved wire keys can no longer desync a mirror', async () => {
    // Regression: a `$splice`-keyed value used to be written into state,
    // emitted, and then silently dropped by the receiver's applier
    const src = new LazyWatch({ config: { ok: 0 } });
    const mirror = new LazyWatch({ config: { ok: 0 } });
    LazyWatch.on(src, d => LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d))));

    assertThrows(() => { src.config.$splice = 'user-data'; });
    assertThrows(() => { src.config.$length = 7; });
    src.config.ok = 1; // a legal write still flows
    await wait(10);

    assertConverged(src, mirror, 'replicas should converge after the rejected writes');
    assertEquals(LazyWatch.resolveIfProxy(mirror), { config: { ok: 1 } });
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  runner.test('hostile $splice op items should be rejected atomically at entry', () => {
    // Op items are full values entering state, so diff validation holds
    // them to the state rules — the whole patch is rejected before any of
    // it applies, on proxy and plain targets alike
    const hostile = { aaa: 1, items: { $splice: [[0, 0, [{ $splice: 'x' }]]], $length: 2 } };

    const proxy = new LazyWatch({ aaa: 0, items: ['a'] });
    assertThrows(() => LazyWatch.patch(proxy, hostile), 'proxy target should reject');
    assertEquals(LazyWatch.resolveIfProxy(proxy), { aaa: 0, items: ['a'] },
      'no part of the patch should apply, not even sibling keys');

    const plain = { aaa: 0, items: ['a'] };
    assertThrows(() => LazyWatch.patch(plain, hostile), 'plain target should reject');
    assertEquals(plain, { aaa: 0, items: ['a'] }, 'plain target should be untouched');

    assertThrows(
      () => LazyWatch.patch(plain, { items: { $splice: [[0, 0, [new Map()]]], $length: 2 } }),
      'collection types inside op items should be rejected too'
    );
    assertEquals(plain, { aaa: 0, items: ['a'] });
    LazyWatch.dispose(proxy);
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
    assertEquals(diff.items.$length, 2);
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
