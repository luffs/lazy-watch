// set-immediate-polyfill.js
export function setImmediatePolyfill(context) {
  if (context.setImmediate && context.clearImmediate) {
    return { polyfilled: false };
  }

  const tasks = new Map();
  let nextId = 1;

  context.setImmediate = function(callback, ...args) {
    const id = nextId++;
    tasks.set(id, { callback, args });
    Promise.resolve().then(() => {
      const task = tasks.get(id);
      if (task) {
        tasks.delete(id);
        task.callback(...task.args);
      }
    });
    return id;
  };

  context.clearImmediate = function(id) {
    tasks.delete(id);
  };

  return { polyfilled: true };
}