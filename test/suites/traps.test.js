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

  // --- Constructor-time trackability ---
  // The constructor argument is kept by reference (later values are
  // cloned), so a frozen container or an exotic property could only
  // arrive through it. A write to one used to throw natively AFTER the
  // diff entry was recorded, so the phantom entry rode along with the
  // next batch and desynced mirrors.
  runner.test('the constructor should reject frozen, sealed, and non-extensible objects', () => {
    assertThrows(() => new LazyWatch(Object.freeze({ a: 1 })));
    assertThrows(() => new LazyWatch({ a: Object.freeze({ x: 1 }) }));
    assertThrows(() => new LazyWatch({ a: Object.seal({ x: 1 }) }));
    assertThrows(() => new LazyWatch({ list: [Object.preventExtensions({ x: 1 })] }));
    assertThrows(() => new LazyWatch({ list: Object.freeze([1, 2]) }));
  });

  runner.test('the constructor should reject accessors and non-default property attributes', () => {
    assertThrows(() => new LazyWatch({ get x() { return 1; } }));
    assertThrows(() => new LazyWatch({ a: { set x(v) {} } }));
    const readOnly = Object.defineProperty({}, 'x', { value: 1, writable: false, enumerable: true, configurable: true });
    assertThrows(() => new LazyWatch({ a: readOnly }));
    const hidden = Object.defineProperty({}, 'x', { value: 1, writable: true, enumerable: false, configurable: true });
    assertThrows(() => new LazyWatch({ a: hidden }));
    const locked = Object.defineProperty({}, 'x', { value: 1, writable: true, enumerable: true, configurable: false });
    assertThrows(() => new LazyWatch({ a: locked }));
  });

  runner.test('trackability rejections should be TypeErrors naming the path', () => {
    try {
      new LazyWatch({ deep: { cfg: Object.freeze({ x: 1 }) } });
      throw new Error('should have thrown');
    } catch (e) {
      assertEquals(e instanceof TypeError, true);
      assertEquals(e.message.includes('"deep.cfg"'), true, `should name the path: ${e.message}`);
    }
    try {
      new LazyWatch({ deep: { get x() { return 1; } } });
      throw new Error('should have thrown');
    } catch (e) {
      assertEquals(e instanceof TypeError, true);
      assertEquals(e.message.includes('"x"') && e.message.includes('"deep"'), true,
        `should name the property and path: ${e.message}`);
    }
  });

  runner.test('a frozen object assigned later is cloned, so it stays trackable (regression guard)', async () => {
    const src = new LazyWatch({});
    const mirror = new LazyWatch({});
    LazyWatch.on(src, d => LazyWatch.patch(mirror, d));

    src.a = Object.freeze({ x: 1 }); // the clone landing in state is extensible
    await wait(5);
    src.a.x = 2;
    await wait(5);
    assertEquals(LazyWatch.snapshot(src), { a: { x: 2 } });
    assertConverged(src, mirror);
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  // --- Detached proxies ---
  // A nested proxy addresses a slot; the raw object behind it stays at that
  // slot for life (assigned values are cloned, containers merge in place).
  // Once the slot is destroyed the object is unreachable from the tree, and
  // a write through the stale handle used to mutate it anyway while
  // recording a diff at the dead path: the sender's state stayed unchanged
  // while every mirror grew a phantom entry.
  runner.test('a write through a handle detached by shift() should throw and keep mirrors converged', async () => {
    const src = new LazyWatch({ todos: [{ id: 1 }, { id: 2 }] });
    const mirror = new LazyWatch({ todos: [{ id: 1 }, { id: 2 }] });
    LazyWatch.on(src, d => LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d))));

    const held = src.todos[1];
    src.todos.shift();
    await wait(5);

    assertThrows(() => { held.done = true; });
    await wait(5);
    assertEquals(LazyWatch.snapshot(src), { todos: [{ id: 2 }] }, 'the detached write must not land');
    assertConverged(src, mirror, 'no phantom element may reach the mirror');
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  runner.test('delete, patch, overwrite, and array methods through a detached handle should throw', async () => {
    const src = new LazyWatch({ user: { name: 'x', tags: ['a'] } });
    let emits = 0;
    LazyWatch.on(src, () => emits++);

    const user = src.user;
    const tags = src.user.tags;
    delete src.user;
    await wait(5);
    assertEquals(emits, 1);

    let error = null;
    try { user.name = 'y'; } catch (e) { error = e; }
    assertEquals(error instanceof Error && error.message.includes('"user"'), true,
      `should name the stale path, got: ${error && error.message}`);
    assertThrows(() => { delete user.name; });
    assertThrows(() => LazyWatch.patch(user, { name: 'y' }));
    assertThrows(() => LazyWatch.overwrite(user, { name: 'y' }));
    assertThrows(() => tags.push('b'));
    assertThrows(() => tags.splice(0, 1));
    assertThrows(() => tags.unshift('b'));
    assertThrows(() => tags.sort());
    assertThrows(() => tags.reverse());
    assertThrows(() => Object.defineProperty(user, 'name', { value: 'y' }));

    await wait(5);
    assertEquals(emits, 1, 'rejected writes must record nothing');
    assertEquals(user.name, 'x', 'reads still return the stale contents');
    assertEquals(user.tags, ['a']);
    LazyWatch.dispose(src);
  });

  runner.test('handles for leaf-replaced and truncated containers should be detached', async () => {
    const src = new LazyWatch({ cfg: { on: true }, list: [{ n: 1 }, { n: 2 }] });
    const cfg = src.cfg;
    const second = src.list[1];

    src.cfg = 'off';
    src.list.length = 1;
    await wait(5);

    assertThrows(() => { cfg.on = false; });
    assertThrows(() => { second.n = 3; });
    // The surviving element's handle is unaffected
    src.list[0].n = 10;
    await wait(5);
    assertEquals(LazyWatch.snapshot(src), { cfg: 'off', list: [{ n: 10 }] });
    LazyWatch.dispose(src);
  });

  runner.test('a handle should stay detached after a new object is assigned at its path', async () => {
    const src = new LazyWatch({ a: { x: 1 } });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    const old = src.a;
    delete src.a;
    src.a = { x: 2 }; // a clone lands at the path; the old object stays detached
    await wait(5);

    assertThrows(() => { old.x = 3; });
    src.a.x = 4; // the live handle works
    await wait(5);
    assertEquals(LazyWatch.snapshot(src), { a: { x: 4 } });
    assertEquals(diffs, [{ a: { x: 2 } }, { a: { x: 4 } }]);
    LazyWatch.dispose(src);
  });

  runner.test('symbol-keyed writes through a detached handle should stay allowed (local-only)', async () => {
    const src = new LazyWatch({ a: { x: 1 } });
    const old = src.a;
    delete src.a;
    await wait(5);

    const META = Symbol('meta');
    old[META] = 'cache'; // never recorded, never synced — no reason to refuse
    assertEquals(old[META], 'cache');
    LazyWatch.dispose(src);
  });

  runner.test('a handle displaced by unshift() should keep addressing its slot (documented design)', async () => {
    const src = new LazyWatch({ todos: [{ id: 1 }, { id: 2 }] });
    const mirror = new LazyWatch({ todos: [{ id: 1 }, { id: 2 }] });
    LazyWatch.on(src, d => LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d))));

    const slot1 = src.todos[1]; // currently id 2
    src.todos.unshift({ id: 0 });
    await wait(5);
    slot1.done = true; // slot 1 now holds id 1
    await wait(5);

    assertEquals(LazyWatch.snapshot(src),
      { todos: [{ id: 0 }, { id: 1, done: true }, { id: 2 }] });
    assertConverged(src, mirror);
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });
}
