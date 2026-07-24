// tests.js - Entry point for the LazyWatch test suite.
// Registers every suite from test/suites/ on a shared runner; shared
// assertions and the runner itself live in test/helpers.js.
import { TestRunner } from './helpers.js';
import { runExamples } from './examples.js';

import registerCore from './suites/core.test.js';
import registerTiming from './suites/timing.test.js';
import registerListeners from './suites/listeners.test.js';
import registerArrays from './suites/arrays.test.js';
import registerValues from './suites/values.test.js';
import registerInverse from './suites/inverse.test.js';
import registerUndoManager from './suites/undo-manager.test.js';
import registerComposeDiffs from './suites/compose-diffs.test.js';
import registerConvergence from './suites/convergence.test.js';
import registerNestedPatch from './suites/nested-patch.test.js';
import registerTraps from './suites/traps.test.js';
import registerScheduler from './suites/scheduler.test.js';
import registerPlainTargets from './suites/plain-targets.test.js';
import registerDeepArrayDiffs from './suites/deep-array-diffs.test.js';

const runner = new TestRunner();

registerCore(runner);
registerTiming(runner);
registerListeners(runner);
registerArrays(runner);
registerValues(runner);
registerInverse(runner);
registerUndoManager(runner);
registerComposeDiffs(runner);
registerConvergence(runner);
registerNestedPatch(runner);
registerTraps(runner);
registerScheduler(runner);
registerPlainTargets(runner);
registerDeepArrayDiffs(runner);

runExamples();

// Run tests after a short delay to let examples run
setTimeout(() => {
  runner.run();
}, 300);
