// run.js - CLI for the convergence fuzzer
//
//   npm run fuzz                                  # random seed, 200 runs x 40 steps per mode
//   npm run fuzz -- --seed 42 --runs 500 --steps 60
//   npm run fuzz -- --seed 42 --mode undo         # one mode only (plain, inverse, undo, bidi)
//   npm run fuzz -- --seed 42 --mode undo --runs 11 --trace   # batch-by-batch trace on failure
//
// Exit code 1 on the first invariant violation; the error message carries
// the seed, mode, run, step, the last operations, and a reproduction
// command. The short fixed-seed run in `npm test` lives in
// test/suites/fuzz.test.js.
import { runFuzz, MODES } from './convergence.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const seed = Number(option('seed', Date.now() % 1000000));
const runs = Number(option('runs', 200));
const steps = Number(option('steps', 40));
const mode = option('mode', null);
const trace = args.includes('--trace');
const modes = mode ? [mode] : MODES;

console.log(`Convergence fuzz: seed ${seed}, ${runs} runs x ${steps} steps, modes ${modes.join(', ')}`);
const started = performance.now();
try {
  const result = runFuzz({ seed, runs, steps, modes, trace });
  const ms = Math.round(performance.now() - started);
  console.log(`ok: ${result.runs} runs, ${result.ops.toLocaleString('en-US')} operations, ${ms} ms`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
