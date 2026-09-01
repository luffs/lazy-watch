// fuzz.test.js - Short fixed-seed runs of the convergence fuzzer (test/fuzz/)
// Every run is deterministic; a failure message carries the reproduction
// command for the longer CLI (`npm run fuzz`).
import { runFuzz, MODES } from '../fuzz/convergence.js';

export default function register(runner) {
  for (const mode of MODES) {
    runner.test(`convergence fuzz should hold every invariant (${mode} mode, fixed seed)`, () => {
      runFuzz({ seed: 1, runs: 40, steps: 25, modes: [mode] });
    });
  }
}
