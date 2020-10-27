#LazyWatch

Deep watch objects (using Proxy) and emit diff asynchronously.

###Install:
```
npm i lazy-watch
```

###USAGE:

```js
const UI = new LazyWatch({ very: true, nice: false })
LazyWatch.on(UI, diff => console.log({ diff }) )
UI.nice = true;
```
