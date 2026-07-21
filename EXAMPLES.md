# LazyWatch Examples

This document provides comprehensive real-world examples demonstrating how to use LazyWatch in various scenarios. For installation instructions and an overview, see the [README](README.md); for the full API documentation, see the [API reference](docs/API.md).

## Table of Contents

- [State Management](#example-1-state-management)
- [Real-time Sync](#example-2-real-time-sync)
- [WebSocket Mirroring with Reconnect Resync](#example-3-websocket-mirroring-with-reconnect-resync)
- [Form Validation](#example-4-form-validation)
- [Silent Initialization](#example-5-silent-initialization)
- [Conditional Change Broadcasting](#example-6-conditional-change-broadcasting)
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

## Example 3: WebSocket Mirroring with Reconnect Resync

Mirror a watched object to other processes over WebSockets. The pattern rests
on two transport facts:

- **While a socket is connected**, TCP already delivers messages exactly once,
  in order — plain diffs are safe with no sequence numbers or acknowledgements.
- **Loss only happens at connection boundaries.** When a socket dies you cannot
  know which in-flight diffs were lost, and diffs are deltas — they must be
  applied exactly once, in order, or replicas silently diverge (structural
  `$splice` ops in particular corrupt an array if applied against the wrong
  state). So never try to replay missed diffs: on every (re)connect, start
  from a fresh snapshot instead. It covers a gap of any size.

`flush()`, `snapshot()`, and `overwrite()` are exactly the pieces this needs.

**Server (owns the state):**

```javascript
import LazyWatch from 'lazy-watch';
import { WebSocketServer } from 'ws';

const state = new LazyWatch({ users: {}, todos: [] });
const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', ws => {
  // A new connection knows nothing yet. Flush first so batched changes are
  // emitted (to the already-connected clients) before the snapshot is taken —
  // every diff sent after this point is a delta against exactly this snapshot.
  LazyWatch.flush(state);
  ws.send(JSON.stringify({ type: 'snapshot', data: LazyWatch.snapshot(state) }));

  // For the lifetime of this socket, plain diffs are all it takes
  const stop = LazyWatch.on(state, diff => {
    ws.send(JSON.stringify({ type: 'diff', data: diff }));
  });
  ws.on('close', stop);
});

// Server-side mutations broadcast automatically
state.todos.push({ text: 'hello', done: false });
```

**Client (holds a mirror):**

```javascript
import LazyWatch from 'lazy-watch';

const mirror = new LazyWatch({});

// Applied diffs are re-emitted by the mirror (that's what makes relay chains
// work), so local listeners react to remote changes like any other change
LazyWatch.on(mirror, diff => render(diff));

function connect() {
  const ws = new WebSocket('ws://localhost:8080');

  ws.onmessage = event => {
    const { type, data } = JSON.parse(event.data);
    if (type === 'snapshot') {
      // overwrite, not patch: deletes anything that drifted while offline
      LazyWatch.overwrite(mirror, data);
    } else {
      LazyWatch.patch(mirror, data);
    }
  };

  // On reconnect the server's snapshot covers whatever was missed
  ws.onclose = () => setTimeout(connect, 1000);
}

connect();
```

### Bidirectional edits

Because applying a diff re-emits it, a naive "send every diff to the other
side" echoes remote changes straight back where they came from — an infinite
loop between two mirrors. Suppress the echo with a flag, using `flush()` to
force the emit to happen *synchronously* while the flag is still set (the
normal microtask batching would fire the listener after the flag is cleared):

```javascript
let applyingRemote = false;

LazyWatch.on(mirror, diff => {
  render(diff);
  if (!applyingRemote) {
    ws.send(JSON.stringify({ type: 'diff', data: diff }));
  }
});

ws.onmessage = event => {
  const { type, data } = JSON.parse(event.data);
  LazyWatch.flush(mirror); // send local changes still batched, before flagging
  applyingRemote = true;
  try {
    if (type === 'snapshot') LazyWatch.overwrite(mirror, data);
    else LazyWatch.patch(mirror, data);
    LazyWatch.flush(mirror); // emit the applied diff now, while flagged
  } finally {
    applyingRemote = false;
  }
};
```

Note that concurrent edits to the same property resolve last-writer-wins by
arrival order — this pattern gives you reliable state transport, not conflict
resolution.

### Non-TCP transports

Over transports without TCP's guarantees — at-least-once brokers that can
redeliver (e.g. MQTT QoS 1), unreliable WebRTC data channels — add a sequence
number in the listener's closure:

```javascript
let seq = 0;
LazyWatch.on(state, diff => channel.send(JSON.stringify({ seq: seq++, diff })));
```

Receivers discard duplicates (`seq <= last`) and treat any gap as "request a
fresh snapshot" — a delta stream can never skip ahead.

---

## Example 4: Form Validation

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

## Example 5: Silent Initialization

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

## Example 6: Conditional Change Broadcasting

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

- **Batching**: Changes are automatically batched using `queueMicrotask`
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
import { LazyWatch } from 'lazy-watch';

interface User {
  name: string;
  age: number;
  profile?: {
    bio: string;
  };
}

const user: User = { name: 'Alice', age: 30 };
const watched = new LazyWatch<User>(user);

// Diffs are typed after the watched object: Patch<User> | null
LazyWatch.on(watched, changes => {
  changes?.age;          // number | null | undefined
  changes?.profile?.bio; // string | null | undefined
  changes?.invalid;      // ✗ TypeScript error — not a User property
});

// Listeners on nested proxies are typed after the subtree
LazyWatch.on(watched.profile!, changes => {
  changes?.bio; // string | null | undefined
});

// Type-safe proxy access
watched.age = 31; // ✓ OK
watched.invalid = true; // ✗ TypeScript error
```

The listener parameter is nullable because nested-proxy listeners receive
`null` when their subtree is deleted — narrowing with `?.` or an early
`if (!changes) return` covers it. Wire-level shapes (index-keyed array
fragments, `$splice` op lists) can be inspected by casting the fragment to
`ChangeSet`.

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

- [README](README.md) - Installation, overview, and quick start
- [API reference](docs/API.md) - Full API documentation, the diff wire format, and supported-value rules
- [GitHub Repository](https://github.com/luffs/lazy-watch)
