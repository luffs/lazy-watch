# LazyWatch

[![npm version](https://img.shields.io/npm/v/lazy-watch.svg)](https://www.npmjs.com/package/lazy-watch)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

Deep watch JavaScript objects using Proxy and emit diffs asynchronously. LazyWatch efficiently tracks changes to objects (including nested properties and arrays) and batches multiple changes into a single update event.

## Features

- 🔄 Deep object watching with Proxy
- ⏱️ Asynchronous batched updates
- 🔍 Detailed change tracking with diffs
- 🧩 Support for nested objects and arrays
- ⏸️ Pause and resume event emissions
- 🤫 Silent mutations without triggering events
- 📦 Efficient patching mechanism
- 🌐 Works in browsers and Node.js

## Installation

```bash
npm install lazy-watch
```

## Basic Usage

```js
// Create a watched object
const UI = new LazyWatch({});

// Listen for changes
LazyWatch.on(UI, diff => console.log({ diff }));

// Make changes
UI.hello = 'world';
// After the next tick, logs: { diff: { hello: 'world' } }
```

### With Throttling

```js
// Create a watched object with 50ms throttle
const UI = new LazyWatch({}, { throttle: 50 });

LazyWatch.on(UI, diff => console.log({ diff }));

// Multiple rapid changes will be batched
UI.count = 1;
UI.count = 2;
UI.count = 3;
// After 50ms, logs once: { diff: { count: 3 } }
```

## API Reference

### Creating Watched Objects

```js
const watchedObject = new LazyWatch(originalObject, options);
```

Creates a proxy around the original object that tracks all changes.

**Parameters:**
- `originalObject` - The object or array to watch
- `options` (optional) - Configuration options
  - `throttle` - Minimum time in milliseconds between emits (default: 0). When set, the first change emits immediately, but subsequent changes within the throttle window are batched together.

### Listening for Changes

```js
LazyWatch.on(watchedObject, callback);
```

Registers a callback function that will be called with a diff object whenever changes are made to the watched object.

### Removing Listeners

```js
LazyWatch.off(watchedObject, callback);
```

Removes a previously registered callback function.

### Pausing and Resuming Event Emissions

```js
LazyWatch.pause(watchedObject);
```

Pauses event emissions. Changes continue to be tracked but listeners won't be notified until `resume()` is called.

```js
LazyWatch.resume(watchedObject);
```

Resumes event emissions. If there are pending changes, they will be emitted immediately.

```js
const isPaused = LazyWatch.isPaused(watchedObject);
```

Returns `true` if the watched object is currently paused, `false` otherwise.

**Example:**
```js
const data = new LazyWatch({ count: 0 });

LazyWatch.on(data, diff => {
  console.log('Changes:', diff);
});

LazyWatch.pause(data);
data.count = 1;
data.count = 2;
data.count = 3;
// No listener notifications while paused

LazyWatch.resume(data);
// Immediately logs: Changes: { count: 3 }
```

### Silent Mutations

```js
const diff = LazyWatch.silent(watchedObject, callback);
```

Executes a callback while suppressing event emissions. Any changes made during the callback are tracked and returned as a diff object. Forces emission of any pending changes before silent execution to ensure a clean slate.

**Parameters:**
- `watchedObject` - The LazyWatch proxy
- `callback` - Function to execute silently

**Returns:**
- A diff object containing changes made during the callback

**Example:**
```js
const data = new LazyWatch({ count: 0, name: '' });

LazyWatch.on(data, diff => {
  console.log('Changes:', diff);
});

// Make silent changes without triggering listeners
const diff = LazyWatch.silent(data, () => {
  data.count = 1;
  data.name = 'test';
});

// diff = { count: 1, name: 'test' }
// No listener was triggered

// Use the returned diff to perform custom operations
console.log('Silent changes:', diff);
```

**Use cases:**
- Initializing state without triggering listeners
- Bulk updates where you want manual control over notifications
- Testing or debugging scenarios where you need to inspect changes without side effects

### Applying Changes

```js
LazyWatch.patch(targetObject, diffObject);
```

Applies changes from a diff object to a target object.

## Examples

For more comprehensive examples and advanced use cases, see [EXAMPLES.md](EXAMPLES.md).

### Basic Object Watching

```js
const user = new LazyWatch({ name: 'John', age: 30 });

LazyWatch.on(user, diff => {
  console.log('User changed:', diff);
});

user.name = 'Jane';
user.age = 31;
// After the next tick, logs: User changed: { name: 'Jane', age: 31 }
```

### Nested Objects

```js
const data = new LazyWatch({
  user: {
    profile: {
      name: 'John',
      settings: {
        theme: 'dark'
      }
    }
  }
});

LazyWatch.on(data, diff => {
  console.log('Data changed:', diff);
});

data.user.profile.settings.theme = 'light';
// After the next tick, logs: Data changed: { user: { profile: { settings: { theme: 'light' } } } }
```

### Working with Arrays

```js
const list = new LazyWatch({ items: [1, 2, 3] });

LazyWatch.on(list, diff => {
  console.log('List changed:', diff);
});

list.items.push(4);
list.items[0] = 10;
// After the next tick, logs: List changed: { items: { 0: 10, 3: 4, length: 4 } }
```

### Syncing Objects

```js
const source = new LazyWatch({ a: 1, b: 2, c: { d: 3 } });
const target = new LazyWatch({ a: 0, b: 0, c: { d: 0 } });

LazyWatch.on(source, diff => {
  // Apply changes from source to target
  LazyWatch.patch(target, diff);
  console.log('Target updated:', target);
});

source.a = 10;
source.c.d = 30;
// After the next tick:
// 1. Logs the diff: { a: 10, c: { d: 30 } }
// 2. Patches target
// 3. Logs: Target updated: { a: 10, b: 2, c: { d: 30 } }
```

### Deleting Properties

```js
const obj = new LazyWatch({ a: 1, b: 2, c: 3 });

LazyWatch.on(obj, diff => {
  console.log('Object changed:', diff);
});

delete obj.b;
// After the next tick, logs: Object changed: { b: null }
```

## Advanced Example

```js
const initialData = () => {
  return { pretty: false, list: [{ nice: false }], right: true, junk: 123 };
};

// Create two instances with the same initial data
const UI = new LazyWatch(initialData());
const mirror = new LazyWatch(initialData());

// Define a change listener that will sync changes to the mirror
const changeListener = diff => {
  console.log('Changes detected:', diff);
  // Apply the changes to the mirror object
  LazyWatch.patch(mirror, diff);
  console.log('Mirror updated:', mirror);
};

// Register the change listener
LazyWatch.on(UI, changeListener);

// Make multiple changes
UI.pretty = true;
UI.list[0].nice = true;
delete UI.junk;

// After the next tick, all changes will be batched into a single update
```

## How It Works

LazyWatch uses JavaScript Proxies to intercept property access, assignment, and deletion operations. When changes are detected, they are collected into a diff object. Using a polyfill for `setImmediate`, these changes are then emitted asynchronously in the next event loop tick, allowing multiple changes to be batched together.

## Testing

To run the tests:

```bash
npm test
```

This will execute the test suite using Jest, which verifies the functionality of LazyWatch including object creation, change detection, event emission, and patching.

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
