# LazyWatch

A lightweight, reactive proxy-based object change tracker for JavaScript and TypeScript. LazyWatch allows you to monitor changes to objects and arrays with automatic batching, deep nesting support, and a clean API.

## Features

- 🎯 **Automatic Change Detection** - Track changes to objects and arrays automatically
- 🔄 **Deep Nesting Support** - Monitor changes at any depth level
- 📦 **Batched Updates** - Multiple synchronous changes are batched into a single notification
- 🧹 **Memory Safe** - Proper cleanup with dispose() method
- 💪 **TypeScript Support** - Full type definitions included
- 🚀 **Zero Dependencies** - Standalone library with optional polyfills
- ⚡ **High Performance** - Efficient proxy-based implementation with caching

## Installation

```bash
npm install lazywatch
```

Or use directly in browser:

```html
<script type="module">
	import { LazyWatch } from './lazy-watch.js';
</script>
```

## Quick Start

```javascript
import { LazyWatch } from 'lazywatch';

// Create a watched object - returns a proxy
const watched = new LazyWatch({ count: 0, user: { name: 'Alice' } });

// Listen for changes using static method
LazyWatch.on(watched, (changes) => {
  console.log('Changes detected:', changes);
});

// Make changes directly - triggers listener with batched changes
watched.count = 1;
watched.user.name = 'Bob';

// Clean up when done
LazyWatch.dispose(watched);
```

## API Reference

### Constructor

#### `new LazyWatch<T>(original: T): T`

Creates a new LazyWatch instance and returns a proxy that tracks changes.

**Parameters:**
- `original` - The object or array to watch

**Returns:**
- A proxy object that behaves like the original but tracks all changes

**Throws:**
- `TypeError` if original is not an object or array

**Example:**
```javascript
const watched = new LazyWatch({ count: 0 });
// watched is now a proxy that tracks changes
watched.count = 1; // This change will be tracked
```

### Static Methods

#### `LazyWatch.on(proxy, listener): void`

Adds a change listener to a LazyWatch proxy.

**Parameters:**
- `proxy` - The proxy returned from the LazyWatch constructor
- `listener` - Callback function that receives a changes object

**Example:**
```javascript
const watched = new LazyWatch({ count: 0 });
LazyWatch.on(watched, (changes) => {
  console.log('Changes:', changes);
});
```

#### `LazyWatch.off(proxy, listener): void`

Removes a previously added change listener.

**Parameters:**
- `proxy` - The LazyWatch proxy
- `listener` - The listener function to remove

**Example:**
```javascript
const listener = (changes) => console.log(changes);
LazyWatch.on(watched, listener);
LazyWatch.off(watched, listener); // Listener removed
```

#### `LazyWatch.overwrite(proxy, source): void`

Replaces the watched object's properties with the source object's properties. Properties not in source are deleted (except for arrays).

**Parameters:**
- `proxy` - The LazyWatch proxy
- `source` - Object containing the new values

**Example:**
```javascript
const watched = new LazyWatch({ a: 1, b: 2, c: 3 });
LazyWatch.overwrite(watched, { a: 10, d: 4 });
// Result: { a: 10, d: 4 } - b and c are deleted
```

#### `LazyWatch.patch(proxy, source): void`

Merges the source object into the watched object without deleting missing properties.

**Parameters:**
- `proxy` - The LazyWatch proxy
- `source` - Object containing values to merge

**Example:**
```javascript
const watched = new LazyWatch({ a: 1, b: 2, c: 3 });
LazyWatch.patch(watched, { a: 10, d: 4 });
// Result: { a: 10, b: 2, c: 3, d: 4 } - b and c remain
```

#### `LazyWatch.dispose(proxy): void`

Cleans up resources and removes all listeners. After disposal, the proxy cannot be used.

**Example:**
```javascript
LazyWatch.dispose(watched);
// All listeners removed, resources freed
```

#### `LazyWatch.resolveIfProxy<T>(obj: T): T`

Resolves a proxy to its original target object.

**Parameters:**
- `obj` - Potentially a proxy object

**Returns:** The original target or the input if not a proxy

**Example:**
```javascript
const original = { count: 0 };
const watched = new LazyWatch(original);
const resolved = LazyWatch.resolveIfProxy(watched.proxy);
// resolved === original
```

## Change Detection

### Change Object Format

The changes object passed to listeners contains the modified properties:

```javascript
{
  propertyName: newValue,
    nested: {
    property: newValue
  },
  deletedProperty: null // null indicates deletion
}
```

### Batching Behavior

Multiple synchronous changes are automatically batched:

```javascript
const watched = new LazyWatch({ a: 1, b: 2, c: 3 });

LazyWatch.on(watched, (changes) => {
  // Called once with all changes
  console.log(changes);
  // { a: 10, b: 20, c: 30 }
});

watched.a = 10;
watched.b = 20;
watched.c = 30;
// Listener called once after all synchronous changes
```

## Usage Examples

### Example 1: State Management

```javascript
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

### Example 2: Real-time Sync

```javascript
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

### Example 3: Undo/Redo System

```javascript
class UndoManager {
  constructor(data) {
    this.data = new LazyWatch(data);
    this.history = [];
    this.historyIndex = -1;
    this.originalStates = [];
    
    LazyWatch.on(this.data, (changes) => {
      if (!this.applying) {
        // Store the original state before changes
        const currentState = JSON.parse(JSON.stringify(this.data));
        
        // Truncate forward history
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.originalStates = this.originalStates.slice(0, this.historyIndex + 1);
        
        this.history.push(changes);
        this.originalStates.push(currentState);
        this.historyIndex++;
      }
    });
  }
  
  undo() {
    if (this.historyIndex < 0) return false;
    
    this.applying = true;
    
    // Restore the state from before this change
    const previousState = this.historyIndex > 0 
      ? this.originalStates[this.historyIndex - 1]
      : this.originalStates[0];
    
    LazyWatch.overwrite(this.data, previousState);
    this.historyIndex--;
    
    this.applying = false;
    return true;
  }
  
  redo() {
    if (this.historyIndex >= this.history.length - 1) return false;
    
    this.applying = true;
    this.historyIndex++;
    
    const changes = this.history[this.historyIndex];
    LazyWatch.patch(this.data, changes);
    
    this.applying = false;
    return true;
  }
  
  canUndo() {
    return this.historyIndex >= 0;
  }
  
  canRedo() {
    return this.historyIndex < this.history.length - 1;
  }
}

// Usage
const undoManager = new UndoManager({ text: 'Hello', count: 0 });

undoManager.data.text = 'Hello World';
undoManager.data.count = 5;

undoManager.undo(); // Reverts count change
undoManager.undo(); // Reverts text change
undoManager.redo(); // Reapplies text change
```

### Example 4: Form Validation

```javascript
class ValidatedForm {
  constructor(initialData, validators) {
    this.data = new LazyWatch(initialData);
    this.validators = validators;
    this.errors = {};
    
    LazyWatch.on(this.data, (changes) => {
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

get data() {
return this.watched.proxy;
}
}

// Usage
const sync = new DataSync({ todos: [] });
sync.data.todos.push({ id: 1, text: 'Buy milk', done: false });
// Automatically synced to server
```

### Example 3: Undo/Redo System

```javascript
class UndoManager {
  constructor(data) {
    this.watched = new LazyWatch(data);
    this.history = [];
    this.currentIndex = -1;
    
    this.watched.on((changes) => {
      if (!this.applying) {
        // Truncate forward history
        this.history = this.history.slice(0, this.currentIndex + 1);
        this.history.push(changes);
        this.currentIndex++;
      }
    });
  }
  
  undo() {
    if (this.currentIndex < 0) return;
    
    this.applying = true;
    const changes = this.history[this.currentIndex];
    this.reverseChanges(changes);
    this.currentIndex--;
    this.applying = false;
  }
  
  redo() {
    if (this.currentIndex >= this.history.length - 1) return;
    
    this.applying = true;
    this.currentIndex++;
    const changes = this.history[this.currentIndex];
    this.watched.patch(changes);
    this.applying = false;
  }
  
  reverseChanges(changes) {
    // Implement reverse logic based on your needs
    // This is simplified - real implementation would be more complex
    for (const key in changes) {
      if (changes[key] === null) {
        // Restore deleted property (would need to store original values)
      } else {
        // Revert to previous value (would need to store original values)
      }
    }
  }
  
  get data() {
    return this.watched.proxy;
  }
}
```

### Example 4: Form Validation

```javascript
class ValidatedForm {
  constructor(initialData, validators) {
    this.watched = new LazyWatch(initialData);
    this.validators = validators;
    this.errors = {};
    
    this.watched.on((changes) => {
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
    return this.watched.proxy;
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

- Changes are batched automatically using `setImmediate`
- Nested proxies are cached for efficiency
- Deep cloning only occurs when necessary
- Use `LazyWatch.patch()` instead of `LazyWatch.overwrite()` when you only need to update specific properties

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

watched.value = 1; // Both listeners execute
```

## Browser Support

LazyWatch works in all modern browsers and Node.js environments that support:
- Proxy (ES2015)
- WeakMap (ES2015)
- Promise (ES2015)

For older environments, use appropriate polyfills.

## TypeScript

Full TypeScript support is included:

```typescript
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

## License

MIT

## Contributing

Contributions are welcome! Please ensure:
- All tests pass
- Code follows the existing style
- New features include tests and documentation

## Changelog

### Version 2.0.0
- Complete rewrite with improved architecture
- Better memory management with proper disposal
- TypeScript support with full type definitions
- Performance improvements with optimized caching
- **Breaking changes**:
    - Constructor now returns proxy directly (use `const watched = new LazyWatch(data)` instead of `watched.proxy`)
    - Methods moved to static API (`LazyWatch.on(watched, callback)` instead of `watched.on(callback)`)
    - Cleaner, more intuitive syntax throughout

### Version 1.0.0
- Initial release