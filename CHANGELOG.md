# Changelog

All notable changes to this project are documented in this file. Version numbers align exactly with the versions published on npm for `lazy-watch`.

This project follows the Keep a Changelog format and adheres to Semantic Versioning.

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
