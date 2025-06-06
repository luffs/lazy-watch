import { LazyWatch } from '../src/index.js';
import { jest } from '@jest/globals';

describe('LazyWatch', () => {
  // Test object creation
  test('should create a proxy object', () => {
    const original = { foo: 'bar' };
    const proxy = new LazyWatch(original);

    expect(proxy).toBeDefined();
    expect(proxy.foo).toBe('bar');
  });

  // Test change detection and event emission
  test('should detect changes and emit diff', (done) => {
    const original = { foo: 'bar', nested: { value: 42 } };
    const proxy = new LazyWatch(original);

    LazyWatch.on(proxy, (diff) => {
      expect(diff).toEqual({ foo: 'changed' });
      done();
    });

    proxy.foo = 'changed';
  });

  // Test nested change detection
  test('should detect nested changes and emit diff', (done) => {
    const original = { nested: { value: 42 } };
    const proxy = new LazyWatch(original);

    LazyWatch.on(proxy, (diff) => {
      expect(diff).toEqual({ nested: { value: 100 } });
      done();
    });

    proxy.nested.value = 100;
  });

  // Test array change detection
  test('should detect array changes and emit diff', (done) => {
    const original = { items: [1, 2, 3] };
    const proxy = new LazyWatch(original);

    LazyWatch.on(proxy, (diff) => {
      expect(diff).toEqual({ items: { 1: 20 } });
      done();
    });

    proxy.items[1] = 20;
  });

  // Test array length change
  test('should detect array length changes and emit diff', (done) => {
    const original = { items: [1, 2, 3] };
    const proxy = new LazyWatch(original);

    LazyWatch.on(proxy, (diff) => {
      expect(diff.items.length).toBe(5);
      done();
    });

    proxy.items.length = 5;
  });

  // Test delete property
  test('should detect deleted properties and emit diff', (done) => {
    const original = { foo: 'bar', toDelete: 'value' };
    const proxy = new LazyWatch(original);

    LazyWatch.on(proxy, (diff) => {
      expect(diff).toEqual({ toDelete: null });
      expect(proxy.toDelete).toBeUndefined();
      done();
    });

    delete proxy.toDelete;
  });

  // Test patching
  test('should patch target object with diff', () => {
    const original = { foo: 'bar', nested: { value: 42 } };
    const target = { foo: 'original', nested: { value: 0 } };
    const diff = { foo: 'patched', nested: { value: 100 } };

    LazyWatch.patch(target, diff);

    expect(target.foo).toBe('patched');
    expect(target.nested.value).toBe(100);
  });

  // Test multiple listeners
  test('should notify multiple listeners', (done) => {
    const original = { foo: 'bar' };
    const proxy = new LazyWatch(original);

    let count = 0;
    const checkDone = () => {
      count++;
      if (count === 2) done();
    };

    LazyWatch.on(proxy, (diff) => {
      expect(diff).toEqual({ foo: 'changed' });
      checkDone();
    });

    LazyWatch.on(proxy, (diff) => {
      expect(diff).toEqual({ foo: 'changed' });
      checkDone();
    });

    proxy.foo = 'changed';
  });

  // Test removing listeners
  test('should remove listeners with off', (done) => {
    const original = { foo: 'bar' };
    const proxy = new LazyWatch(original);

    const listener1 = jest.fn();
    const listener2 = (diff) => {
      expect(diff).toEqual({ foo: 'changed' });
      expect(listener1).not.toHaveBeenCalled();
      done();
    };

    LazyWatch.on(proxy, listener1);
    LazyWatch.on(proxy, listener2);

    LazyWatch.off(proxy, listener1);

    proxy.foo = 'changed';
  });

  // Test batching changes
  test('should batch multiple changes', (done) => {
    const original = { a: 1, b: 2, c: 3 };
    const proxy = new LazyWatch(original);

    LazyWatch.on(proxy, (diff) => {
      expect(diff).toEqual({ a: 10, b: 20, c: 30 });
      done();
    });

    proxy.a = 10;
    proxy.b = 20;
    proxy.c = 30;
  });
});
