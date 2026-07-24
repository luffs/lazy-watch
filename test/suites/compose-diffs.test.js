// compose-diffs.test.js - LazyWatch.composeDiffs: pure composition of sequential diffs
import { LazyWatch } from '../../src/lazy-watch.js';
import { assertEquals, assertObjectEqual, assertTrue, assertThrows, assertComposeEquivalent } from '../helpers.js';

export default function register(runner) {
  // composeDiffs tests

  runner.test('composeDiffs should merge sequential diffs with the newer winning', () => {
    const older = { a: 1, shared: 'old', nested: { x: 1, keep: true } };
    const newer = { b: 2, shared: 'new', nested: { x: 9 } };

    const composed = LazyWatch.composeDiffs(older, newer);
    assertObjectEqual(composed, { a: 1, shared: 'new', nested: { x: 9, keep: true }, b: 2 });
    assertComposeEquivalent({ a: 0, shared: '', nested: { x: 0, keep: false }, other: 1 },
      older, newer, 'composed application should match sequential application');
  });

  runner.test('composed deletions should still delete', () => {
    assertEquals(LazyWatch.composeDiffs({ k: { deep: { n: 1 } } }, { k: null }), { k: null },
      'a newer deletion wins over an older subtree write');
    assertEquals(LazyWatch.composeDiffs({ k: null }, { k: 'leaf' }), { k: 'leaf' },
      'a newer leaf wins over an older deletion');
    assertComposeEquivalent({ k: { old: true } }, { k: { deep: { n: 1 } } }, { k: null });
  });

  runner.test('composeDiffs should be pure', () => {
    const older = { nested: { x: 1 }, list: { $splice: [[0, 0, [{ v: 1 }]]], length: 1 } };
    const newer = { nested: { y: 2 } };
    const olderBefore = JSON.stringify(older);
    const newerBefore = JSON.stringify(newer);

    const composed = LazyWatch.composeDiffs(older, newer);
    composed.nested.x = 999;
    composed.list.$splice[0][2][0].v = 999;

    assertEquals(JSON.parse(olderBefore), older, 'older input must not be mutated or aliased');
    assertEquals(JSON.parse(newerBefore), newer, 'newer input must not be mutated or aliased');
  });

  runner.test('composeDiffs should throw when an object diff follows a deletion or leaf write', () => {
    // Verified against the appliers: collapsing delete-then-recreate into one
    // diff makes receivers merge into their stale container instead of
    // replacing it, so this pair must fail loudly
    assertThrows(() => LazyWatch.composeDiffs({ k: null }, { k: { b: 2 } }),
      'object diff after a deletion should refuse to compose');
    assertThrows(() => LazyWatch.composeDiffs({ k: 5 }, { k: { b: 2 } }),
      'object diff after a leaf write should refuse to compose');
    try {
      LazyWatch.composeDiffs({ outer: { k: null } }, { outer: { k: { b: 2 } } });
      throw new Error('should have thrown');
    } catch (e) {
      assertTrue(e instanceof TypeError && e.message.includes('"outer.k"'),
        `error should be a TypeError naming the path, got: ${e.message}`);
    }
  });

  runner.test('a wholesale array in the newer diff should compose over anything', () => {
    const composed = LazyWatch.composeDiffs({ k: null }, { k: [1, 2] });
    assertTrue(Array.isArray(composed.k), 'composed value should be a real array');
    assertComposeEquivalent({ k: [9, 9, 9] }, { k: null }, { k: [1, 2] },
      'wholesale arrays are self-describing and replace stale receiver arrays');
  });

  runner.test('an array fragment following a deletion should revive to a real array', () => {
    const composed = LazyWatch.composeDiffs({ k: null }, { k: { 0: 'a', 1: 'b', length: 2 } });
    assertTrue(Array.isArray(composed.k), 'the fragment should be revived');
    assertEquals(composed.k, ['a', 'b']);
    assertComposeEquivalent({ k: [9, 9, 9] }, { k: null }, { k: { 0: 'a', 1: 'b', length: 2 } });
  });

  runner.test('$splice op lists should concatenate and converge', async () => {
    const src = new LazyWatch({ items: ['a', 'b', 'c'] });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.items.splice(1, 1);        // batch 1: pure op
    LazyWatch.flush(src);
    src.items.unshift('start');    // batch 2: pure op
    LazyWatch.flush(src);

    const composed = LazyWatch.composeDiffs(diffs[0], diffs[1]);
    assertEquals(composed.items.$splice.length, 2, 'op lists should concatenate');

    const mirror = { items: ['a', 'b', 'c'] };
    LazyWatch.patch(mirror, composed);
    assertEquals(mirror, LazyWatch.snapshot(src), 'composed ops should converge the mirror');
    LazyWatch.dispose(src);
  });

  runner.test('index writes before later $splice ops should refuse to compose', () => {
    assertThrows(() => LazyWatch.composeDiffs(
      { items: { 0: 'x', length: 3 } },
      { items: { $splice: [[0, 1]], length: 2 } }
    ), 'ops cannot jump the queue past earlier index writes');
  });

  runner.test('a $splice op followed by index writes should compose', async () => {
    const src = new LazyWatch({ items: ['b', 'c'] });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.items.unshift('a');  // batch 1: op
    LazyWatch.flush(src);
    src.items[0] = 'z';      // batch 2: index write
    LazyWatch.flush(src);

    const mirror = { items: ['b', 'c'] };
    LazyWatch.patch(mirror, LazyWatch.composeDiffs(diffs[0], diffs[1]));
    assertEquals(mirror, LazyWatch.snapshot(src), 'op-then-write should converge composed');
    LazyWatch.dispose(src);
  });

  runner.test('a fragment over a wholesale array value should materialize', async () => {
    // A newly created property records the array wholesale (there is no
    // container to merge into); array-over-array assignments record
    // fragments instead, covered by the deep-array-diff tests
    const src = new LazyWatch({});
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    src.list = [1, 2];   // batch 1: wholesale array value in the diff
    LazyWatch.flush(src);
    src.list.push(3);    // batch 2: index fragment
    LazyWatch.flush(src);

    assertTrue(Array.isArray(diffs[0].list), 'new-property array should record wholesale');
    const composed = LazyWatch.composeDiffs(diffs[0], diffs[1]);
    assertTrue(Array.isArray(composed.list), 'fragment should be absorbed into the array value');
    assertEquals(composed.list, [1, 2, 3]);

    const mirror = { list: ['x'] };
    LazyWatch.patch(mirror, composed);
    assertEquals(mirror, LazyWatch.snapshot(src));
    LazyWatch.dispose(src);
  });

  runner.test('undefined values in hand-built diffs should compose as deletions', () => {
    assertEquals(LazyWatch.composeDiffs({ a: 1 }, { a: undefined }), { a: null });
    assertEquals(LazyWatch.composeDiffs({ a: undefined }, { b: 2 }), { a: null, b: 2 });
  });

  runner.test('composeDiffs should reject non-diff inputs and unsupported values', () => {
    assertThrows(() => LazyWatch.composeDiffs(null, {}), 'null input should be rejected');
    assertThrows(() => LazyWatch.composeDiffs({}, [1]), 'array input should be rejected');
    assertThrows(() => LazyWatch.composeDiffs({ m: new Map() }, {}), 'Map inside a diff should be rejected');
    assertThrows(() => LazyWatch.composeDiffs({}, JSON.parse('{"__proto__": {"x": 1}}')),
      'prototype pollution attempts should be rejected');
  });

  runner.test('composed offline buffers should converge (fuzz)', async () => {
    const src = new LazyWatch({ items: [], meta: {} });
    const diffs = [];
    LazyWatch.on(src, d => diffs.push(d));

    let seed = 4321;
    const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;

    for (let round = 0; round < 60; round++) {
      const opsThisRound = 1 + rnd(3);
      for (let i = 0; i < opsThisRound; i++) {
        const len = src.items.length;
        switch (rnd(10)) {
          case 0: src.items.push({ v: rnd(100) }); break;
          case 1: src.items.unshift({ v: rnd(100) }); break;
          case 2: if (len) src.items.shift(); break;
          case 3: if (len) src.items.splice(rnd(len), rnd(2) + 1); break;
          case 4: src.items.splice(rnd(len + 1), 0, { v: rnd(100) }); break;
          case 5: if (len) src.items[rnd(len)] = { v: rnd(100) }; break;
          case 6: if (len) { const el = src.items[rnd(len)]; if (el && typeof el === 'object') el.v = rnd(100); } break;
          case 7: src.meta['k' + rnd(5)] = { deep: { n: rnd(100) } }; break;
          case 8: delete src.meta['k' + rnd(5)]; break;
          case 9: src.meta['k' + rnd(5)] = rnd(2) ? 'leaf' : null; break;
        }
      }
      LazyWatch.flush(src);
    }

    // Offline-buffer usage: fold diffs together, falling back to a flush of
    // the buffer whenever a pair refuses to compose
    const mirror = { items: [], meta: {} };
    let pending = null;
    let composed = 0;
    let fellBack = 0;
    for (const diff of diffs) {
      if (!pending) { pending = diff; continue; }
      try {
        pending = LazyWatch.composeDiffs(pending, diff);
        composed++;
      } catch (e) {
        assertTrue(e instanceof TypeError, `unexpected error type: ${e.message}`);
        LazyWatch.patch(mirror, pending);
        pending = diff;
        fellBack++;
      }
    }
    if (pending) LazyWatch.patch(mirror, pending);

    assertEquals(mirror, LazyWatch.snapshot(src),
      `mirror should converge (${diffs.length} diffs, ${composed} composed, ${fellBack} fallbacks)`);
    assertTrue(composed > 0, 'the fuzz should exercise successful composition');
    LazyWatch.dispose(src);
  });
}
