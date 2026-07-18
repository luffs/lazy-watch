# Changelog

All notable changes to this project are documented in this file. Version numbers align exactly with the versions published on npm for `lazy-watch`.

This project follows the Keep a Changelog format and adheres to Semantic Versioning.

## [3.1.0] - 2026-07-18

- security: Block prototype pollution through received diffs. `__proto__`,
  `constructor`, and `prototype` are now reserved property names: writes into
  watched state reject them with a `TypeError`, `patch`/`overwrite`/`patchObject`
  refuse diffs containing them before touching any state, the appliers and
  `Utils.reviveArrayDiffs` skip them as defense-in-depth, and the `get` trap no
  longer wraps them in proxies (previously `watched.__proto__` returned a
  watchable proxy of `Object.prototype`). Prior to this fix, a malicious or
  corrupt diff such as `{"__proto__": {...}}` applied via `patch` polluted
  `Object.prototype` in the receiving process
- fix: `NaN` and `±Infinity` are rejected with a `TypeError` at write time —
  JSON serializes them as `null`, which receivers interpret as a deletion,
  silently desyncing replicas
- fix: Assigning `undefined` is normalized to a deletion (emitted as
  `{ prop: null }`) — JSON drops `undefined` values from diffs, so the old
  behavior left receivers permanently out of sync
- fix: Deletions applied by `overwrite`/`patch` are recorded in the receiver's
  own diff, so relay chains (A → B → C) propagate them; previously the middle
  replica applied a deletion without re-emitting it
- fix: Truncating an array (`arr.length = n`) now drops pending diff entries
  for indices beyond the new length (the cleanup branch was unreachable due to
  an incorrect guard), producing smaller diffs
- fix: `LazyWatch.getPendingDiff` uses a structured clone instead of a JSON
  round-trip, so `Date` leaf values keep their type
- tests: Cover pollution vectors across all appliers, reserved-name rejection,
  `undefined`/`NaN` wire round-trips, relay-chain deletions, truncation
  cleanup, and `Date` preservation (88 tests total)

## [3.0.0] - 2026-07-18

- feat!: Structural array mutations (`splice`, `unshift`, `shift`) are emitted
  as compact `$splice` ops (`[start, deleteCount, items]` triples applied
  before a fragment's index keys) instead of per-index writes — prepending one
  item to a 1,000-element array now emits ~68 bytes instead of ~34 KB.
  Consecutive ops in a batch append to one op list; if index writes are
  already pending on the array, the op falls back to per-index recording so
  ordering stays correct. Received ops are applied through the receiver's own
  proxy, so relaying mirrors re-emit them compactly, and
  `Utils.reviveArrayDiffs` replays ops when the receiving side lacks the array
  entirely. **Breaking (wire format):** pre-3.0 receivers would merge a
  `$splice` key verbatim into their arrays — all replicas must run ≥ 3.0.0
- feat!: Watched state is validated. `Map`, `Set`, `WeakMap`, `WeakSet`,
  `Promise`, `ArrayBuffer`, and typed arrays are rejected with a `TypeError`
  at every entry point (constructor, assignment, `patch`/`overwrite`/
  `patchObject`) — their internal-slot mutations bypass the proxy and would
  silently desync replicas. `Date` and `RegExp` remain supported as leaf
  values (methods work; only wholesale replacement is tracked). Validation
  runs before any mutation, so rejected operations leave state untouched.
  New helpers: `Utils.assertSupported`, `Utils.rejectedTypeName`
- fix: `main` field pointed at a nonexistent `src/index.js`; both `main` and
  `exports` now resolve to `src/lazy-watch.js`, with `types` exposed in the
  `exports` map
- types: Rewrite `lazy-watch.d.ts` — `LazyWatch` is declared as a const with a
  construct signature returning the watched type itself (the old
  `constructor(): T` annotation was invalid TypeScript, leaving proxies typed
  as an empty class), phantom exports that don't exist at runtime
  (`Utils`, `DiffTracker`, `EventEmitter`, `ProxyHandler`) are removed, and
  `patch`/`overwrite`/`patchObject` accept `Patch<T>` (recursive partial with
  `null` deletions) instead of `Partial<T>`. Compile-time type tests
  (`npm run test:types`) guard both accepted and rejected usage
- chore: Add ISC `LICENSE` file, GitHub Actions test workflow (Node 20/22/24
  plus type-check job), non-zero exit code from the test runner on failure,
  and a `files` allowlist so the npm tarball ships only `src`, README, and
  LICENSE (plus `keywords`, `engines`, `sideEffects` metadata)
- docs: Document the `debounce` option, supported values, and the `$splice`
  wire format

## [2.6.0] - 2026-07-17

- fix: Applying an index-keyed array diff (e.g. `{ 1: 'b', length: 2 }`) to a target
  that lacks the field no longer stores the fragment verbatim as a plain object —
  `patch`, `overwrite`, and `patchObject` now revive such fragments into real arrays,
  so replicas with shape drift converge instead of silently corrupting
- feat: Array diffs always include `length`, making array fragments self-describing
  on the wire (previously `push()` could emit a fragment without it)
- feat: Expose `Utils.isArrayDiff` and `Utils.reviveArrayDiffs` for applications that
  need to repair data corrupted by earlier versions
- tests: Cover missing-field revival, nested fragments, existing-array merging,
  false-positive guards, and replica convergence under shape drift

## [2.4.7] - 2025-12-21

- feat: Add `LazyWatch.patchObject` static method for patching normal (non-proxy) objects
- docs: Update documentation to include patchObject usage

## [2.4.2] - 2025-12-07

- fix: Ensure array `length` is updated on overwrite to keep target/source in sync
- chore: Bump version to 2.4.2

## [2.4.1] - 2025-11-09

- docs: Clarify optional parameters in LazyWatch constructor using default value syntax
- types: Fix JSDoc types for constructor params; rename parameter references from `proxy` to `watched`
- dx: Improve constructor fallback/return to aid editor IntelliSense and code completion

## [2.4.0] - 2025-11-08

- feat: Add nested proxy listeners that receive path-relative diffs
- docs/tests: Document and add tests for nested proxy listener behavior
- bench: Refactor benchmarks for listener notification and throttle/debounce scenarios

## [2.3.0] - 2025-11-07

- feat: Introduce `LazyWatch.silent` to apply changes without triggering listeners
- tests: Streamline and focus silent method tests
- docs: Add README examples and documentation for silent mode

## [2.1.4] - 2025-10-20

- perf: Optimize diff creation in ProxyHandler with lazy initialization to reduce overhead

## [2.1.3] - 2025-10-20

- refactor: Rework `overwrite` in ProxyHandler to track changes via diff and handle array length updates
- perf: Optimize nested object copying behavior

## [2.1.2] - 2025-10-20

- refactor: Improve EventEmitter emit scheduling; add `clearPending` method
- fix: Handle array replacements correctly in ProxyHandler

## [2.1.1] - 2025-10-19

- perf: Use `performance.now()` for higher precision timing in EventEmitter

## [2.1.0] - 2025-10-19 

- feat: Add throttling support with configurable options

## [2.0.0] - 2025-10-08

- refactor!: Rewrite LazyWatch core for modularity and scalability

## [1.4.1] - 2025-06-22

- docs: Update README with detailed usage examples and features

## [1.4.0] - 2025-06-06

- chore: Remove Vue.js-specific dependency code from `index.js`

## [1.3.6] - 2025-06-06

- tests: Add tests for LazyWatch and integrate Jest setup

## [1.3.5] - 2025-04-19

- build: Add `"type": "module"` to `package.json`

## [1.3.4] - 2023-02-27

- build: Add `.npmignore`

## [1.3.3] - 2023-02-27

- build: Remove `type: module` from `package.json`

## [1.3.2] - 2023-02-27

- build: Add `exports` field to `package.json`

## [1.3.1] - 2023-02-27

- fix: Resolve edge cases with arrays

## [1.3.0] - 2023-02-27

- fix: Use forked local `setimmediate` without `process.nextTick` to address NW.js issues

## [1.2.0] - 2023-01-25

- fix: Use `setimmediate` (with browser polyfill) to fix delay issues

## [1.1.8] - 2023-01-24

- perf: Change `setTimeout` delay from 1ms to 0ms to avoid throttling when tab is unfocused

## [1.1.7] - 2022-11-26

- fix: Ensure array `length` updates when patched

## [1.1.6] - 2022-11-14

- chore/docs: Move project to GitHub and improve documentation

## [1.1.4] - 2021-12-15

- fix: Improve array handling for better Vue reactivity

## [1.1.3] - 2021-04-04

- feat: Notify objects of deletes

## [1.1.2] - 2021-03-28

- feat: Notify objects of changes for Vue.js

## [1.1.1] - 2021-02-03

- Published to npm. No additional notes recorded.

## [1.1.0] - 2020-10-28

- Published to npm. No additional notes recorded.

## [1.0.3] - 2020-10-28

- Published to npm. No additional notes recorded.

## [1.0.2] - 2020-10-28

- Published to npm. No additional notes recorded.

## [1.0.1] - 2020-10-27

- Published to npm. No additional notes recorded.

## [1.0.0] - 2020-10-27

- Initial release on npm.

---

Helpful links:

- Package on npm: https://www.npmjs.com/package/lazy-watch
- GitHub Releases: https://github.com/luffs/lazy-watch/releases

[2.4.7]: https://www.npmjs.com/package/lazy-watch/v/2.4.7
[2.4.2]: https://www.npmjs.com/package/lazy-watch/v/2.4.2
[2.4.1]: https://www.npmjs.com/package/lazy-watch/v/2.4.1
[2.4.0]: https://www.npmjs.com/package/lazy-watch/v/2.4.0
[2.3.0]: https://www.npmjs.com/package/lazy-watch/v/2.3.0
[2.1.4]: https://www.npmjs.com/package/lazy-watch/v/2.1.4
[2.1.3]: https://www.npmjs.com/package/lazy-watch/v/2.1.3
[2.1.2]: https://www.npmjs.com/package/lazy-watch/v/2.1.2
[2.1.1]: https://www.npmjs.com/package/lazy-watch/v/2.1.1
[2.1.0]: https://www.npmjs.com/package/lazy-watch/v/2.1.0
[2.0.0]: https://www.npmjs.com/package/lazy-watch/v/2.0.0
[1.4.1]: https://www.npmjs.com/package/lazy-watch/v/1.4.1
[1.4.0]: https://www.npmjs.com/package/lazy-watch/v/1.4.0
[1.3.6]: https://www.npmjs.com/package/lazy-watch/v/1.3.6
[1.3.5]: https://www.npmjs.com/package/lazy-watch/v/1.3.5
[1.3.4]: https://www.npmjs.com/package/lazy-watch/v/1.3.4
[1.3.3]: https://www.npmjs.com/package/lazy-watch/v/1.3.3
[1.3.2]: https://www.npmjs.com/package/lazy-watch/v/1.3.2
[1.3.1]: https://www.npmjs.com/package/lazy-watch/v/1.3.1
[1.3.0]: https://www.npmjs.com/package/lazy-watch/v/1.3.0
[1.2.0]: https://www.npmjs.com/package/lazy-watch/v/1.2.0
[1.1.8]: https://www.npmjs.com/package/lazy-watch/v/1.1.8
[1.1.7]: https://www.npmjs.com/package/lazy-watch/v/1.1.7
[1.1.6]: https://www.npmjs.com/package/lazy-watch/v/1.1.6
[1.1.4]: https://www.npmjs.com/package/lazy-watch/v/1.1.4
[1.1.3]: https://www.npmjs.com/package/lazy-watch/v/1.1.3
[1.1.2]: https://www.npmjs.com/package/lazy-watch/v/1.1.2
[1.1.1]: https://www.npmjs.com/package/lazy-watch/v/1.1.1
[1.1.0]: https://www.npmjs.com/package/lazy-watch/v/1.1.0
[1.0.3]: https://www.npmjs.com/package/lazy-watch/v/1.0.3
[1.0.2]: https://www.npmjs.com/package/lazy-watch/v/1.0.2
[1.0.1]: https://www.npmjs.com/package/lazy-watch/v/1.0.1
[1.0.0]: https://www.npmjs.com/package/lazy-watch/v/1.0.0
