// examples.js - Usage examples printed before the test run
import { LazyWatch } from '../src/lazy-watch.js';

export function runExamples() {
  console.log('\n=== LazyWatch Usage Examples ===\n');

  // Example 0: Throttled change detection
  console.log('Example 0: Throttled change detection');
  {
    const state = { count: 0 };
    const watched = new LazyWatch(state, { throttle: 50 });

    LazyWatch.on(watched, (changes) => {
      console.log('Throttled changes:', changes);
    });

    // Rapid changes will be batched
    watched.count = 1;
    watched.count = 2;
    watched.count = 3;
    // Only emits after 50ms with final changes

    setTimeout(() => LazyWatch.dispose(watched), 150);
  }

  // Example 0b: Debounced change detection
  console.log('Example 0b: Debounced change detection');
  {
    const searchQuery = { text: '' };
    const watched = new LazyWatch(searchQuery, { debounce: 100 });

    LazyWatch.on(watched, (changes) => {
      console.log('Debounced search query:', changes);
      // In real app: performSearch(changes.text);
    });

    // Simulate user typing - each keystroke resets the debounce timer
    watched.text = 'h';
    setTimeout(() => { watched.text = 'he'; }, 20);
    setTimeout(() => { watched.text = 'hel'; }, 40);
    setTimeout(() => { watched.text = 'hell'; }, 60);
    setTimeout(() => { watched.text = 'hello'; }, 80);
    // Only emits 100ms after the last change (at 'hello')

    setTimeout(() => LazyWatch.dispose(watched), 250);
  }

  // Example 1: Basic usage
  console.log('Example 1: Basic change detection');
  {
    const state = { count: 0, name: 'App' };
    const watched = new LazyWatch(state);

    LazyWatch.on(watched, (changes) => {
      console.log('Changes detected:', changes);
    });

    watched.count = 1;
    watched.name = 'MyApp';

    setTimeout(() => LazyWatch.dispose(watched), 100);
  }

  // Example 2: Nested objects
  console.log('\nExample 2: Nested object tracking');
  {
    const user = {
      profile: {
        name: 'Alice',
        settings: {
          theme: 'dark'
        }
      }
    };

    const watched = new LazyWatch(user);

    LazyWatch.on(watched, (changes) => {
      console.log('User changes:', changes);
    });

    watched.profile.settings.theme = 'light';

    setTimeout(() => LazyWatch.dispose(watched), 100);
  }

  // Example 3: Array operations
  console.log('\nExample 3: Array tracking');
  {
    const todos = {
      items: ['Task 1', 'Task 2']
    };

    const watched = new LazyWatch(todos);

    LazyWatch.on(watched, (changes) => {
      console.log('Todo changes:', changes);
    });

    watched.items.push('Task 3');
    watched.items[0] = 'Updated Task 1';

    setTimeout(() => LazyWatch.dispose(watched), 100);
  }

  // Example 4: State synchronization
  console.log('\nExample 4: State synchronization');
  {
    const localState = { user: { name: 'Alice', age: 30 } };
    const watched = new LazyWatch(localState);

    LazyWatch.on(watched, (changes) => {
      console.log('Syncing changes to server:', changes);
      // In real app: sendToServer(changes);
    });

    // Simulate receiving update from server
    setTimeout(() => {
      LazyWatch.patch(watched, { user: { name: 'Alice', age: 31, email: 'alice@example.com' } });
      console.log('State after patch:', watched);
    }, 50);

    setTimeout(() => LazyWatch.dispose(watched), 150);
  }

  // Example 5: Multiple listeners for different concerns
  console.log('\nExample 5: Multiple listeners');
  {
    const appState = { count: 0, history: [] };
    const watched = new LazyWatch(appState);

    // Logger listener
    LazyWatch.on(watched, (changes) => {
      console.log('[Logger]', new Date().toISOString(), changes);
    });

    // History listener
    LazyWatch.on(watched, (changes) => {
      console.log('[History] Recording changes...');
    });

    // Analytics listener
    LazyWatch.on(watched, (changes) => {
      console.log('[Analytics] Tracking user action');
    });

    watched.count++;

    setTimeout(() => LazyWatch.dispose(watched), 100);
  }
}
