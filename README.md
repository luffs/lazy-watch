# LazyWatch

[![npm version](https://img.shields.io/npm/v/lazy-watch.svg)](https://www.npmjs.com/package/lazy-watch)
[![CI](https://github.com/luffs/lazy-watch/actions/workflows/test.yml/badge.svg)](https://github.com/luffs/lazy-watch/actions/workflows/test.yml)
[![bundle size (min+gzip)](https://deno.bundlejs.com/badge?q=lazy-watch)](https://bundlejs.com/?q=lazy-watch)
![Zero dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

Deep watch JavaScript objects using Proxy and emit diffs asynchronously. LazyWatch efficiently tracks changes to objects (including nested properties and arrays) and batches multiple changes into a single update event.

## Features

- 🔄 Deep object watching with Proxy
- ⏱️ Asynchronous batched updates
- 🔍 Detailed change tracking with diffs
- 🧩 Support for nested objects and arrays
- ⏸️ Pause and resume event emissions
- 🤫 Silent mutations without triggering events
- ↩️ Opt-in inverse diffs (undo) and atomic transactions with rollback
- 🕑 Built-in undo/redo manager with configurable history depth
- 📦 Efficient patching mechanism
- 🌐 Works in browsers and Node.js
- 🪶 Tiny: ~6.5 kB min+gzip, zero dependencies, no build step

## Scope and Non-Goals

LazyWatch is built for **single-writer-per-property or server-ordered sync**:
UI state, dashboards, mirrors of authoritative state, and relay chains where
one side owns a given piece of data at a time (or a server imposes the order,
as in the [WebSocket example](EXAMPLES.md#example-3-websocket-mirroring-with-reconnect-resync)).
Within that scope its diffs are plain human-readable JSON with zero metadata
overhead, and conflicts resolve **last-writer-wins by arrival order** — the
last diff applied to a property is the value everyone keeps. The same applies
to undo: inverse diffs revert *state*, not *intent*, so reverting a change
after someone else touched the same property overwrites their change too.

**Non-goal: concurrent conflict resolution.** If two parties can edit the
same field at the same time — collaborative text editing, offline-first
multi-writer documents — and neither edit may be lost, that requires CRDTs or
operational transforms (causality metadata, element identity, tombstones),
which LazyWatch deliberately omits to stay small and its wire format plain.
For those use cases, embed a purpose-built library such as
[Yjs](https://yjs.dev) or [Automerge](https://automerge.org) for the shared
document, and use LazyWatch for the surrounding application state.

## Installation

```bash
npm install lazy-watch
```

The published package is plain ES modules — the same readable source that
lives in `src/`. No build step, no dependencies, about 6.5 kB min+gzip for
the whole library (checked in CI with `npm run test:size`).

## Quick Start

```js
import { LazyWatch } from 'lazy-watch';

// Create a watched object
const UI = new LazyWatch({});

// Listen for changes
LazyWatch.on(UI, diff => console.log({ diff }));

// Make changes
UI.hello = 'world';
// After the next tick, logs: { diff: { hello: 'world' } }
```

Nested objects and arrays are tracked the same way, and multiple synchronous
changes batch into a single diff:

```js
const app = new LazyWatch({ user: { name: 'Alice' }, todos: [] });
LazyWatch.on(app, diff => console.log(diff));

app.user.name = 'Bob';
app.todos.push('ship it');
// One batch: { user: { name: 'Bob' }, todos: { 0: 'ship it', length: 1 } }
```

Diffs are plain JSON — deletions are represented as `null` — so they travel
over any transport, and applying them to another instance keeps a mirror in
sync:

```js
const mirror = new LazyWatch({ user: { name: 'Alice' }, todos: [] });
LazyWatch.on(app, diff => LazyWatch.patch(mirror, diff));
```

High-frequency changes can be smoothed with the `throttle` or `debounce`
options:

```js
const search = new LazyWatch({ text: '' }, { debounce: 100 });
LazyWatch.on(search, diff => performSearch(search.text));
// Emits once, 100ms after the last keystroke
```

## API Overview

Everything is a static method taking the watched proxy. The full reference —
semantics, edge cases, and examples for each — lives in
**[docs/API.md](docs/API.md)**.

| | |
|---|---|
| **Watch & listen** | [`new LazyWatch(obj, options)`](docs/API.md#creating-watched-objects) · [`on`](docs/API.md#listening-for-changes) · [`once`](docs/API.md#one-shot-listeners) · [`off`](docs/API.md#removing-listeners) · [`flush`](docs/API.md#flushing-pending-changes) · [`pause` / `resume` / `isPaused`](docs/API.md#pausing-and-resuming-event-emissions) |
| **Apply changes** | [`patch`](docs/API.md#patching-lazywatch-proxies) · [`overwrite`](docs/API.md#overwriting-lazywatch-proxies) · [`patchObject`](docs/API.md#patching-normal-objects) · [`composeDiffs`](docs/API.md#composing-diffs) |
| **Undo & atomicity** | [`inverse` option](docs/API.md#inverse-diffs-undo) · [`transaction`](docs/API.md#transactions) · [`createUndoManager`](docs/API.md#undo-manager) · [`silent`](docs/API.md#silent-mutations) |
| **Inspect** | [`snapshot`](docs/API.md#taking-snapshots) · [`getPendingDiff`](docs/API.md#inspecting-pending-changes) · [`isProxy` / `resolveIfProxy`](docs/API.md#identifying-and-unwrapping-proxies) |
| **Lifecycle** | [`dispose`](docs/API.md#disposing) |

Two reference sections are worth reading before shipping sync:

- [Array diffs and shape drift](docs/API.md#array-diffs-and-shape-drift) —
  how array changes are encoded (index fragments, compact `$splice` ops,
  wholesale values) and how replicas with different shapes converge
- [Supported values](docs/API.md#supported-values) — what belongs in watched
  state, what is rejected loudly and why, and the symbol-key escape hatch
  for local-only data

## Documentation

- **[API reference](docs/API.md)** — every method, the diff wire format, and
  the supported-value rules
- **[Examples & recipes](EXAMPLES.md)** — state management, WebSocket
  mirroring with reconnect resync, undo/redo, form validation, and more
- **[Changelog](CHANGELOG.md)** — release history

## How It Works

LazyWatch uses JavaScript Proxies to intercept property access, assignment, and deletion operations. When changes are detected, they are collected into a diff object. Using `queueMicrotask`, these changes are then emitted asynchronously in the next microtask, allowing multiple changes to be batched together.

## Testing

To run the tests:

```bash
npm test
```

This will execute the test suite using a custom test runner, which verifies the functionality of LazyWatch including object creation, change detection, event emission, and patching.

Additional checks, all run in CI: `npm run test:types` compiles the
TypeScript definitions, `npm run test:coverage` enforces coverage thresholds
(~98% statements at the time of writing), `npm run test:size` verifies the
bundle-size budget, and `npm run benchmark:check` runs the performance suite
with an order-of-magnitude regression guard.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

## Repository

[GitHub Repository](https://github.com/luffs/lazy-watch)
