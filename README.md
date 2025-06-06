# LazyWatch

Deep watch objects (using Proxy) and emit diff asynchronously.

### Install:
```
npm i lazy-watch
```

### Simple Usage:

```js
const UI = new LazyWatch({})
LazyWatch.on(UI, diff => console.log({ diff }))
UI.hello = 'world'
```

### Example:

```js
const initialData = () => {
  return { pretty: false, list: [{ nice: false  }], right: true, junk: 123 }
}
const UI = new LazyWatch(initialData())
const mirror = new LazyWatch(initialData())
const changeListener = diff => {
  console.log({ diff })
  // the diff could be sent via websocket to another browser or something
  LazyWatch.patch(mirror, diff)
}
LazyWatch.on(UI, changeListener)

UI.pretty = true;
UI.list[0].forEach(item => {
  item.nice = true
})
delete UI.junk
// this will result in changeListener getting called once with all changes
```

### Testing:

To run the tests:

```
npm test
```

This will execute the test suite using Jest, which verifies the functionality of LazyWatch including object creation, change detection, event emission, and patching.
