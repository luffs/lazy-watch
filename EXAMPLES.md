# LazyWatch Examples

This document provides comprehensive real-world examples demonstrating how to use LazyWatch in various scenarios. For installation instructions and API documentation, see the [README](README.md).

## Table of Contents

- [State Management](#example-1-state-management)
- [Real-time Sync](#example-2-real-time-sync)
- [Form Validation](#example-3-form-validation)
- [Silent Initialization](#example-4-silent-initialization)
- [Conditional Change Broadcasting](#example-5-conditional-change-broadcasting)
- [Advanced Topics](#advanced-topics)
- [TypeScript](#typescript)

---

## Example 1: State Management

Build a simple state management system with subscription support:

```javascript
import LazyWatch from 'lazy-watch';

class Store {
  constructor(initialState) {
    this.state = new LazyWatch(initialState);
    this.subscribers = [];

    LazyWatch.on(this.state, (changes) => {
      this.subscribers.forEach(fn => fn(this.state, changes));
    });
  }

  subscribe(fn) {
    this.subscribers.push(fn);
    return () => {
      const index = this.subscribers.indexOf(fn);
      if (index > -1) this.subscribers.splice(index, 1);
    };
  }

  dispose() {
    LazyWatch.dispose(this.state);
    this.subscribers = [];
  }
}

// Usage
const store = new Store({ count: 0, user: null });

const unsubscribe = store.subscribe((state, changes) => {
  console.log('State updated:', state);
  console.log('Changes:', changes);
});

store.state.count++;
store.state.user = { name: 'Alice' };
```

---

## Example 2: Real-time Sync

Synchronize local changes with a remote server:

```javascript
import LazyWatch from 'lazy-watch';

class DataSync {
  constructor(localData) {
    this.data = new LazyWatch(localData);
    this.syncQueue = [];

    LazyWatch.on(this.data, (changes) => {
      this.queueSync(changes);
    });
  }

  async queueSync(changes) {
    this.syncQueue.push(changes);
    await this.flush();
  }

  async flush() {
    if (this.syncing || this.syncQueue.length === 0) return;

    this.syncing = true;
    const batch = [...this.syncQueue];
    this.syncQueue = [];

    try {
      await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      });
    } catch (error) {
      console.error('Sync failed:', error);
      this.syncQueue.unshift(...batch); // Re-queue on failure
    } finally {
      this.syncing = false;
    }
  }
}

// Usage
const sync = new DataSync({ todos: [] });
sync.data.todos.push({ id: 1, text: 'Buy milk', done: false });
// Automatically synced to server
```

---

## Example 3: Form Validation

Create a form with automatic validation on changes:

```javascript
import LazyWatch from 'lazy-watch';

class ValidatedForm {
  constructor(initialData, validators) {
    this.watched = new LazyWatch(initialData);
    this.validators = validators;
    this.errors = {};

    LazyWatch.on(this.watched, (changes) => {
      this.validateChanges(changes);
    });
  }

  validateChanges(changes) {
    for (const field in changes) {
      if (this.validators[field]) {
        const error = this.validators[field](changes[field]);
        if (error) {
          this.errors[field] = error;
        } else {
          delete this.errors[field];
        }
      }
    }

    this.onValidationChange?.(this.errors);
  }

  get data() {
    return this.watched;
  }

  isValid() {
    return Object.keys(this.errors).length === 0;
  }
}

// Usage
const form = new ValidatedForm(
  { email: '', password: '' },
  {
    email: (value) => {
      if (!value.includes('@')) return 'Invalid email';
    },
    password: (value) => {
      if (value.length < 8) return 'Password too short';
    }
  }
);

form.onValidationChange = (errors) => {
  console.log('Validation errors:', errors);
};

form.data.email = 'invalid';  // Triggers validation
form.data.email = 'user@example.com';  // Valid
```

---

## Example 4: Silent Initialization

Load initial configuration without triggering change listeners:

```javascript
import LazyWatch from 'lazy-watch';

class ConfigManager {
  constructor() {
    this.config = new LazyWatch({
      apiUrl: '',
      timeout: 5000,
      retries: 3,
      features: {}
    });

    LazyWatch.on(this.config, (changes) => {
      console.log('Config changed:', changes);
      this.saveToLocalStorage(changes);
      this.notifyListeners(changes);
    });
  }

  // Load initial config without triggering change listeners
  async loadFromServer() {
    const serverConfig = await fetch('/api/config').then(r => r.json());

    // Use silent to initialize without triggering save/notify
    const diff = LazyWatch.silent(this.config, () => {
      this.config.apiUrl = serverConfig.apiUrl;
      this.config.timeout = serverConfig.timeout;
      this.config.retries = serverConfig.retries;
      this.config.features = serverConfig.features;
    });

    console.log('Loaded config:', diff);
    // No saveToLocalStorage or notifyListeners called during init
  }

  // Subsequent updates will trigger listeners normally
  updateConfig(updates) {
    Object.assign(this.config, updates);
    // This triggers the listener as expected
  }

  saveToLocalStorage(changes) {
    const current = JSON.parse(localStorage.getItem('config') || '{}');
    localStorage.setItem('config', JSON.stringify({ ...current, ...changes }));
  }

  notifyListeners(changes) {
    // Notify other parts of the app about config changes
    window.dispatchEvent(new CustomEvent('configChanged', { detail: changes }));
  }
}

// Usage
const configManager = new ConfigManager();
await configManager.loadFromServer(); // Silent initialization
configManager.updateConfig({ timeout: 10000 }); // Triggers listeners
```

---

## Example 5: Conditional Change Broadcasting

Control when changes are broadcast to listeners:

```javascript
import LazyWatch from 'lazy-watch';

class SmartState {
  constructor(initialState) {
    this.state = new LazyWatch(initialState);
    this.listeners = new Set();

    LazyWatch.on(this.state, (changes) => {
      this.broadcastChanges(changes);
    });
  }

  // Perform changes and decide whether to broadcast
  transaction(callback, shouldBroadcast = true) {
    if (!shouldBroadcast) {
      // Use silent for internal updates
      return LazyWatch.silent(this.state, callback);
    }

    // Normal updates that trigger listeners
    callback();
    return null;
  }

  // Internal update that shouldn't notify listeners
  internalUpdate(data) {
    const diff = this.transaction(() => {
      Object.assign(this.state, data);
    }, false);

    console.log('Internal update applied:', diff);
    return diff;
  }

  // Public update that notifies listeners
  publicUpdate(data) {
    this.transaction(() => {
      Object.assign(this.state, data);
    }, true);
  }

  broadcastChanges(changes) {
    this.listeners.forEach(listener => listener(changes));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// Usage
const state = new SmartState({ count: 0, internal: 0 });

state.subscribe((changes) => {
  console.log('Public changes:', changes);
});

state.internalUpdate({ internal: 42 }); // No broadcast
state.publicUpdate({ count: 1 }); // Broadcasts to subscribers
```

---

## Advanced Topics

### Memory Management

Always call `LazyWatch.dispose()` when you're done with a proxy to prevent memory leaks:

```javascript
// In a component lifecycle
class MyComponent {
  constructor() {
    this.state = new LazyWatch({ count: 0 });
  }

  destroy() {
    LazyWatch.dispose(this.state); // Important!
  }
}
```

### Performance Considerations

- **Batching**: Changes are automatically batched using `setImmediate`
- **Proxy Caching**: Nested proxies are cached for efficiency
- **Deep Cloning**: Only occurs when necessary during patching
- **Method Choice**: Use `LazyWatch.patch()` instead of `LazyWatch.overwrite()` when you only need to update specific properties
- **Throttling**: Use the `throttle` option to reduce emit frequency for high-frequency updates:

```javascript
// Good for mouse tracking, real-time data streams, etc.
const watched = new LazyWatch({ x: 0, y: 0 }, { throttle: 16 }); // ~60fps
```

### Error Handling

LazyWatch catches errors in listeners to prevent one failing listener from affecting others:

```javascript
const watched = new LazyWatch({ value: 0 });

LazyWatch.on(watched, () => {
  throw new Error('Listener error');
});

LazyWatch.on(watched, () => {
  console.log('This still runs');
});

watched.value = 1; // Both listeners execute, error is logged
```

### Nested Proxy Listeners

You can register listeners on nested objects or arrays within a watched object. Nested listeners receive **path-relative diffs** - only the changes relevant to that subtree:

```javascript
const data = new LazyWatch({
  user: { name: 'Alice', age: 30 },
  settings: { theme: 'dark' }
});

// Root listener receives full diffs
LazyWatch.on(data, changes => {
  console.log('Root:', changes); // { user: { age: 31 } }
});

// Nested listener receives path-relative diffs
LazyWatch.on(data.user, changes => {
  console.log('User:', changes); // { age: 31 }
});

data.user.age = 31;
```

This is particularly useful when different components manage different sections of your application state.

---

## TypeScript

Full TypeScript support is included:

```typescript
import LazyWatch from 'lazy-watch';

interface User {
  name: string;
  age: number;
  profile?: {
    bio: string;
  };
}

const user: User = { name: 'Alice', age: 30 };
const watched = new LazyWatch<User>(user);

LazyWatch.on(watched, (changes) => {
  // changes is properly typed
  console.log(changes);
});

// Type-safe proxy access
watched.age = 31; // ✓ OK
watched.invalid = true; // ✗ TypeScript error
```

### Generic Type Support

LazyWatch preserves the type of your watched object:

```typescript
interface AppState {
  count: number;
  user: {
    name: string;
    permissions: string[];
  };
}

const state = new LazyWatch<AppState>({
  count: 0,
  user: {
    name: 'Bob',
    permissions: ['read']
  }
});

// All operations are type-checked
state.count = 10; // ✓
state.user.permissions.push('write'); // ✓
state.user.email = 'test@example.com'; // ✗ Error
```

---

## See Also

- [README](README.md) - Installation, API documentation, and basic examples
- [GitHub Repository](https://github.com/luffs/lazy-watch)
