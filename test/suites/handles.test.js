// handles.test.js - Handles and listeners follow their objects: through
// structural ops, on receivers applying $splice ops, through undo, and
// through a rolled-back transaction
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertTrue, assertThrows, assertConverged, wait } from '../helpers.js';

const ids = list => LazyWatch.snapshot(list).map(x => x.id);

export default function register(runner) {
  runner.test('a handle should follow its object through splice, unshift, sort, and reverse', async () => {
    const app = new LazyWatch({ list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
    const c = app.list[2];
    app.list.unshift({ id: 'z' });
    app.list.splice(1, 1);
    app.list.reverse();
    app.list.sort((x, y) => (x.id < y.id ? -1 : 1));
    c.done = true;
    assertEquals(ids(app.list), ['b', 'c', 'd', 'z']);
    assertEquals(LazyWatch.snapshot(app.list[1]), { id: 'c', done: true });
    assertTrue(app.list[1] === c, 'the same proxy, read again');
    LazyWatch.dispose(app);
  });

  runner.test('a move by splice, push, or assignment should put the same object back', async () => {
    const app = new LazyWatch({ list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], other: {} });
    const mirror = { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], other: {} };
    LazyWatch.on(app, d => LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d))));

    const a = app.list[0];
    app.list.push(app.list.shift());
    assertEquals(ids(app.list), ['b', 'c', 'a']);
    a.x = 1;
    const [b] = app.list.splice(0, 1);
    app.other.kept = b;
    b.y = 2;
    assertEquals(LazyWatch.snapshot(app), { list: [{ id: 'c' }, { id: 'a', x: 1 }], other: { kept: { id: 'b', y: 2 } } });
    // Put back once only: a second insertion of the same handle is a copy
    app.list.splice(0, 0, a);
    a.z = 3;
    assertEquals(LazyWatch.snapshot(app.list[0]), { id: 'a', x: 1 }, 'the copy');
    assertEquals(LazyWatch.snapshot(app.list[2]), { id: 'a', x: 1, z: 3 }, 'the object itself');
    await wait(5);
    assertConverged(app, mirror);
    LazyWatch.dispose(app);
  });

  runner.test('a handle on a mirror should follow the objects a sender moves', async () => {
    const src = new LazyWatch({ list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    const mirror = new LazyWatch({ list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    LazyWatch.on(src, d => LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d))));
    const held = mirror.list[2];

    src.list.splice(0, 0, ...src.list.splice(2, 1)); // c to the front: an op out, an op in
    src.list.reverse();
    await wait(5);
    assertEquals(ids(mirror.list), ['b', 'a', 'c']);
    held.seen = true;
    assertEquals(LazyWatch.snapshot(mirror.list[2]), { id: 'c', seen: true }, 'the mirror\'s own c, not a copy');
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  runner.test('a handle on a mirror should follow an element a sender moves to an array the mirror never read', async () => {
    const init = () => ({ a: [{ id: 'x', n: 1 }], b: [] });
    const src = new LazyWatch(init());
    const mirror = new LazyWatch(init());
    LazyWatch.on(src, d => LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d))));
    const held = mirror.a[0]; // mirror.b is never read through a proxy
    const heard = [];
    LazyWatch.on(held, d => heard.push(d));

    src.b.splice(0, 0, ...src.a.splice(0, 1));
    await wait(5);
    held.n = 2;
    await wait(5);
    assertEquals(LazyWatch.snapshot(mirror), { a: [], b: [{ id: 'x', n: 2 }] });
    assertEquals(heard, [{ n: 2 }], 'moved, then changed: never told it left');
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
  });

  runner.test('undoing a move should move the objects back, handles and all', async () => {
    const app = new LazyWatch({ list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    const manager = LazyWatch.createUndoManager(app);
    const c = app.list[2];
    const log = [];
    LazyWatch.on(c, d => log.push(d));

    app.list.splice(0, 0, ...app.list.splice(2, 1));
    LazyWatch.flush(app);
    assertEquals(ids(app.list), ['c', 'a', 'b']);
    manager.undo();
    assertEquals(ids(app.list), ['a', 'b', 'c']);
    assertTrue(app.list[2] === c, 'undo put the object itself back');
    manager.redo();
    assertTrue(app.list[0] === c);
    await wait(5);
    assertEquals(log, [], 'only moved');
    LazyWatch.dispose(app);
  });

  runner.test('a change to an object inside a moved element should reach its listener after the element\'s own arrays shift', async () => {
    // The element goes out and back in (reverse), then an array inside it
    // shifts: what the batch changed before the move is found where the
    // listener's object was when the element went out
    const app = new LazyWatch({ e: [{ id: 'a' }, { id: 'b', items: [0, [-1]] }] });
    let received = 'never-called';
    LazyWatch.on(app.e[1].items[1], d => { received = d; });

    app.e[1].items[1].length = 0;
    app.e.reverse();
    app.e[0].items.unshift('z');
    await wait(5);
    assertEquals(received, []);
    LazyWatch.dispose(app);
  });

  runner.test('a rolled-back transaction should leave every object where it was, handles and listeners untouched', async () => {
    const app = new LazyWatch({ list: [{ id: 'a' }, { id: 'b' }], meta: { n: 1 } });
    const b = app.list[1];
    const meta = app.meta;
    const log = [];
    LazyWatch.on(b, d => log.push(d));
    LazyWatch.on(meta, d => log.push(d));

    assertThrows(() => LazyWatch.transaction(app, () => {
      app.list.reverse();
      app.list.push({ id: 'c' });
      app.list.length = 1;
      delete app.meta;
      throw new Error('rollback');
    }));
    await wait(5);
    assertEquals(LazyWatch.snapshot(app), { list: [{ id: 'a' }, { id: 'b' }], meta: { n: 1 } });
    assertTrue(app.list[1] === b && app.meta === meta, 'the same objects, in their places');
    b.x = 1;
    await wait(5);
    assertEquals(log, [{ x: 1 }], 'listeners heard nothing of the transaction');
    LazyWatch.dispose(app);
  });

  runner.test('a push followed by a splice in one batch should reach receivers in order', async () => {
    const src = new LazyWatch({ items: [] }, { inverse: true });
    let captured = null;
    LazyWatch.on(src, (diff, inverse) => { captured = { diff, inverse }; });
    src.items.push({ v: 48 });
    src.items.splice(0, 0, { v: 36 });
    src.items.splice(2, 0, { v: 52 });
    src.items.shift();
    LazyWatch.flush(src);
    const post = LazyWatch.snapshot(src);
    assertEquals(post, { items: [{ v: 48 }, { v: 52 }] });

    const receiver = { items: [] };
    LazyWatch.patch(receiver, JSON.parse(JSON.stringify(captured.diff)));
    assertEquals(receiver, post, 'the pushed element goes in as an op before the ops that count on it');
    LazyWatch.patch(receiver, JSON.parse(JSON.stringify(captured.inverse)));
    assertEquals(receiver, { items: [] });
    LazyWatch.dispose(src);
  });

  runner.test('undoing a splice, a truncation, and a push in one batch should restore the array exactly', async () => {
    // The inverse's ops each expect the array as they left it: the push
    // must be undone before the truncated tail goes back in front of it
    const src = new LazyWatch({ b: [['v8', true], 1, 1, 0, { a: 1 }] }, { inverse: true });
    delete src.b[1];
    delete src.b[2];
    LazyWatch.flush(src);
    let inverse = null;
    LazyWatch.on(src, (d, inv) => { inverse = inv; });
    const pre = LazyWatch.snapshot(src);
    src.b.length = 4;       // before any op: undone by a key at index 4
    src.b.splice(0, 1);
    src.b.length = 2;       // after one: undone by an op
    src.b[2] = { e: {} };   // grows where the undone truncation puts the tail back
    LazyWatch.flush(src);
    LazyWatch.silent(src, () => LazyWatch.patch(src, JSON.parse(JSON.stringify(inverse))));
    assertEquals(LazyWatch.snapshot(src), pre);
    LazyWatch.dispose(src);
  });

  runner.test('composeDiffs should refuse a bare length change followed by ops on the same array', async () => {
    // Ops recorded against a grown array cannot run before the growth
    assertThrows(() => LazyWatch.composeDiffs({ a: { $length: 3 } }, { a: { $splice: [[2, 1, []]], $length: 2 } }));
    // Ops after ops still compose
    const composed = LazyWatch.composeDiffs({ a: { $splice: [[0, 1, []]], $length: 1 } }, { a: { $splice: [[1, 0, ['x']]], $length: 2 } });
    assertEquals(composed, { a: { $splice: [[0, 1, []], [1, 0, ['x']]], $length: 2 } });
  });

  runner.test('a handle put back at the end should be a move: an op, quiet listeners, the mirror\'s own object', async () => {
    const init = () => ({ list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], other: [] });
    const src = new LazyWatch(init(), { inverse: true });
    const mirror = new LazyWatch(init());
    const batches = [];
    LazyWatch.on(src, (d, inv) => {
      batches.push([d, inv]);
      LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d)));
    });
    const c = src.list[2];
    const heard = [];
    LazyWatch.on(c, d => heard.push(d));
    const mirrored = mirror.list[2];
    const mirrorHeard = [];
    LazyWatch.on(mirrored, d => mirrorHeard.push(d));
    const pre = LazyWatch.snapshot(src);

    src.list.sort((x, y) => (x.id < y.id ? 1 : -1));
    src.list.push(...src.list.splice(0, 1));           // c: out, and back at the end
    const [a] = src.list.splice(1, 1);
    src.list[src.list.length] = a;                      // the same, by assignment
    const [b] = src.list.splice(0, 1);
    src.other.push(b);                                  // into another array
    await wait(5);
    assertEquals(ids(src.list), ['c', 'a']);
    assertEquals(ids(src.other), ['b']);
    const [diff, inverse] = batches[0];
    for (const node of [diff.list, diff.other]) {
      assertEquals(Object.keys(node).filter(k => /^\d+$/.test(k)), [], 'recorded as ops, not index writes');
    }
    assertEquals(heard, [], 'a pure move tells the listener nothing');
    assertEquals(mirrorHeard, [], 'nor the mirror\'s');
    assertTrue(mirror.list[0] === mirrored, 'the mirror put its own c back, not a copy');
    assertTrue(src.list[0] === c && src.list[1] === a && src.other[0] === b);
    assertConverged(src, mirror);
    const undone = new LazyWatch(LazyWatch.snapshot(src));
    LazyWatch.patch(undone, JSON.parse(JSON.stringify(inverse)));
    assertEquals(LazyWatch.snapshot(undone), pre, 'the inverse undoes it');

    c.x = 1;
    assertThrows(() => LazyWatch.transaction(src, () => {
      src.list.push(...src.list.splice(0, 1));
      throw new Error('abort');
    }), /abort/);
    await wait(5);
    assertTrue(src.list[0] === c, 'rolled back to the object itself');
    assertEquals(heard, [{ x: 1 }]);
    LazyWatch.dispose(src);
    LazyWatch.dispose(mirror);
    LazyWatch.dispose(undone);
  });

  runner.test('a listener should stay exact when its object, changed, leaves and comes back by a write in one batch', async () => {
    const cases = [
      ['into an object key', () => ({ list: [{ id: 'a', e: 1 }, 'x'], box: {} }), app => app.list[0],
        (app, h) => { delete h.e; const [m] = app.list.splice(0, 1); app.box.k = m; }],
      ['over a leaf', () => ({ list: [{ id: 'a', e: 1 }, 'x'] }), app => app.list[0],
        (app, h) => { delete h.e; const [m] = app.list.splice(0, 1); app.list[0] = m; }],
      ['past the end', () => ({ list: [{ id: 'a', e: 1 }] }), app => app.list[0],
        (app, h) => { delete h.e; const [m] = app.list.splice(0, 1); app.list[2] = m; }],
      ['deleted, then assigned', () => ({ user: { n: 1, age: 3 } }), app => app.user,
        (app, h) => { delete h.age; delete app.user; app.other = h; }],
      ['truncated, then pushed', () => ({ list: [{ id: 'a', e: 1 }] }), app => app.list[0],
        (app, h) => { delete h.e; app.list.length = 0; app.list.push(h); }],
      ['popped, then pushed', () => ({ list: [{ id: 'a', e: 1 }] }), app => app.list[0],
        (app, h) => { delete h.e; app.list.push(app.list.pop()); }],
      ['inside an object moved', () => ({ list: [{ s: { e: 1, f: 2 } }], box: {} }), app => app.list[0].s,
        (app, h) => { delete h.e; const [m] = app.list.splice(0, 1); app.box.k = m; }],
    ];
    for (const [name, init, pick, act] of cases) {
      const app = new LazyWatch(init());
      const mirror = new LazyWatch(init());
      LazyWatch.on(app, d => LazyWatch.patch(mirror, JSON.parse(JSON.stringify(d))));
      const h = pick(app);
      const box = { v: LazyWatch.snapshot(h) };
      LazyWatch.on(h, d => { LazyWatch.patch(box, { v: d }); });
      act(app, h);
      await wait(5);
      assertEquals(box.v, LazyWatch.snapshot(h), `${name}: the listener's copy`);
      assertConverged(app, mirror, `${name}: the mirror`);
      LazyWatch.dispose(app);
      LazyWatch.dispose(mirror);
    }
  });

  runner.test('an inverse completed from an array with holes should delete what the batch put at a hole', async () => {
    const src = new LazyWatch({ e: [null, null, 0] }, { inverse: true });
    delete src.e[0];
    delete src.e[1];
    LazyWatch.flush(src);
    let inverse = null;
    LazyWatch.on(src, (d, inv) => { inverse = inv; });
    const pre = LazyWatch.snapshot(src);
    src.e[2] = 5;          // a partial record of e
    delete src.e;          // completed from the live array, holes and all
    src.e = [];
    src.e.splice(0, 0, 'x');
    LazyWatch.flush(src);
    LazyWatch.silent(src, () => LazyWatch.patch(src, JSON.parse(JSON.stringify(inverse))));
    assertEquals(LazyWatch.snapshot(src), pre);
    LazyWatch.dispose(src);
  });
}
