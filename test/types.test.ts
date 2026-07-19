// types.test.ts - Compile-time checks for lazy-watch.d.ts
// Run with: npx -p typescript tsc --project test/tsconfig.json
// This file is never executed; tsc failing (including unused @ts-expect-error) is the test.
import { LazyWatch, PROXY_TARGET, LAZYWATCH_INSTANCE } from '../src/lazy-watch.js';
import type { ChangeSet, ChangeListener, Patch, Unsubscribe, UndoManager } from '../src/lazy-watch.js';

interface User {
  name: string;
  age: number;
  tags: string[];
  profile: { theme: string };
}

const user: User = { name: 'Alice', age: 30, tags: [], profile: { theme: 'dark' } };

// The constructor returns a proxy typed as the watched object itself
const watched = new LazyWatch(user, { throttle: 50, debounce: 100 });
watched.age = 31;
watched.profile.theme = 'light';

// @ts-expect-error - age is a number
watched.age = 'thirty-one';

// Listeners receive diffs typed after the watched object (nullable: nested
// listeners receive null when their subtree is deleted)
LazyWatch.on(watched, changes => {
  const age: number | null | undefined = changes?.age;
  const theme: string | null | undefined = changes?.profile?.theme;
  void age, theme;
  // @ts-expect-error - diffs only carry the watched object's properties
  changes?.bogus;
});
LazyWatch.on(watched, changes => {
  // @ts-expect-error - changes may be null; narrow before deep access
  const t: string = changes.profile.theme;
  void t;
});
// Nested proxies type their listeners after the subtree
LazyWatch.on(watched.profile, changes => {
  const theme: string | null | undefined = changes?.theme;
  void theme;
});
// A standalone ChangeListener annotation (default type param) still works
const loose: ChangeListener = changes => { const c: ChangeSet | null = changes; void c; };
LazyWatch.on(watched, loose);
LazyWatch.off(watched, loose);
LazyWatch.off(watched, () => {});

// on/once return an unsubscribe function
const stop: Unsubscribe = LazyWatch.on(watched, () => {});
stop();
const stopOnce: () => void = LazyWatch.once(watched, () => {});
stopOnce();

// Listener options: once and AbortSignal
const controller = new AbortController();
LazyWatch.on(watched, () => {}, { signal: controller.signal, once: true });
LazyWatch.once(watched, () => {}, { signal: controller.signal });
LazyWatch.flush(watched);

// @ts-expect-error - once() does not accept a nested once option
LazyWatch.once(watched, () => {}, { once: false });
// @ts-expect-error - signal must be an AbortSignal
LazyWatch.on(watched, () => {}, { signal: 'abort' });

// @ts-expect-error - listener must be a function
LazyWatch.on(watched, 'not a function');

// Patches allow partial updates, null deletions, and diff fragments
LazyWatch.patch(watched, { age: 32 });
LazyWatch.patch(watched, { age: null });
LazyWatch.patch(watched, { tags: { 1: 'b', length: 2 } } as ChangeSet);
LazyWatch.overwrite(watched, { name: 'Bob' });

const plain = { a: 1, b: 2, c: { d: 3 } };
LazyWatch.patchObject(plain, { b: null, c: { d: 30 } });

// composeDiffs takes and returns plain diffs
const composed: ChangeSet = LazyWatch.composeDiffs({ a: 1 }, { a: null, b: 2 });
void composed;

const p: Patch<User> = { profile: { theme: 'light' }, age: null };
void p;

// Statics
const resolved: User = LazyWatch.resolveIfProxy(watched);
void resolved;
const b1: boolean = LazyWatch.isProxy(watched);
const b2: boolean = LazyWatch.isPaused(watched);
void b1, b2;
LazyWatch.pause(watched);
LazyWatch.resume(watched);
const pending: ChangeSet = LazyWatch.getPendingDiff(watched);
void pending;
const snap: User = LazyWatch.snapshot(watched);
void snap;
const subSnap: { theme: string } = LazyWatch.snapshot(watched.profile);
void subSnap;
const diff: ChangeSet = LazyWatch.silent(watched, () => { watched.age = 33; });
void diff;

// Undo manager
const manager: UndoManager = LazyWatch.createUndoManager(watched, { limit: 100 });
const didUndo: boolean = manager.undo();
const didRedo: boolean = manager.redo();
const cu: boolean = manager.canUndo;
const cr: boolean = manager.canRedo;
void didUndo, didRedo, cu, cr;
manager.clear();
manager.dispose();
// @ts-expect-error - canUndo is read-only
manager.canUndo = true;
// @ts-expect-error - limit must be a number
LazyWatch.createUndoManager(watched, { limit: 'many' });

// Inverse diffs and transactions
const inv = new LazyWatch({ n: 1 }, { inverse: true });
LazyWatch.on(inv, (changes, inverse) => { void changes; void inverse; });
// The inverse is typed like the forward diff
LazyWatch.on(inv, (changes, inverse) => {
  const prev: number | null | undefined = inverse?.n;
  void changes, prev;
});
const txResult: number = LazyWatch.transaction(inv, () => { inv.n = 2; return 42; });
void txResult;
LazyWatch.transaction(inv, () => {}); // void callbacks are fine
LazyWatch.dispose(inv);
LazyWatch.dispose(watched);

// @ts-expect-error - primitives cannot be watched
new LazyWatch(42);
// @ts-expect-error - null cannot be watched
new LazyWatch(null);

// Utils
const isDiff: boolean = LazyWatch.Utils.isArrayDiff({ 0: 'a', length: 1 });
void isDiff;
LazyWatch.Utils.reviveArrayDiffs({ items: { 1: 'b', length: 2 } });
const cloned: User = LazyWatch.Utils.deepClone(user);
void cloned;
const isObj: boolean = LazyWatch.Utils.isObjectOrArray([]);
void isObj;

// Symbols
const s1: symbol = PROXY_TARGET;
const s2: symbol = LAZYWATCH_INSTANCE;
void s1, s2;
