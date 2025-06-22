# LazyWatch

[![npm version](https://img.shields.io/npm/v/lazy-watch.svg)](https://www.npmjs.com/package/lazy-watch)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

Deep watch JavaScript objects using Proxy and emit diffs asynchronously. LazyWatch efficiently tracks changes to objects (including nested properties and arrays) and batches multiple changes into a single update event.

## Features

- 🔄 Deep object watching with Proxy
- ⏱️ Asynchronous batched updates
- 🔍 Detailed change tracking with diffs
- 🧩 Support for nested objects and arrays
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

## API Reference

### Creating Watched Objects

```js
const watchedObject = new LazyWatch(originalObject);
```

Creates a proxy around the original object that tracks all changes.

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

### Applying Changes

```js
LazyWatch.patch(targetObject, diffObject);
```

Applies changes from a diff object to a target object.

## Examples

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
