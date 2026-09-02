// regression-guard.js - Order-of-magnitude performance regression guard
//
// Not a micro-benchmark tracker: shared CI runners are far too noisy for
// per-percent comparisons, and gh-pages trend services are out (this
// repo's Actions policy allows GitHub-owned actions only). Instead this
// guards the invariants that survive machine variance:
//
// - Ratio guards compare LazyWatch against the plain-object baseline
//   measured in the same run on the same machine, so machine speed
//   cancels out. Limits sit roughly 10x above today's ratios — they catch
//   an accidental O(n^2), a hot-path clone, or a synchronous emit, not
//   normal drift.
// - Floor guards are absolute ops/sec lower bounds for benchmarks that
//   have no plain baseline, set 10-40x below the numbers measured when
//   this guard was added.
//
// The guard is evaluated and printed on every core benchmark run;
// failures only make the process exit non-zero under `--check` (which CI
// passes), so local exploration on a slow machine never fails the run.
// When a limit is hit legitimately (an intentional trade-off), adjust it
// here in the same commit and say why.

// [benchmark, baseline it may not fall too far behind, max slowdown]
//
// The ratios are large because the plain baselines are honest: a JIT
// compiles a property read on a stable object down to a cycle or two,
// while a Proxy trap costs tens of nanoseconds, so ~100x is the true
// price of a proxied read and ~500x that of a proxied write (each write
// records a diff entry and the batch emits once per iteration). They
// used to look like 7x and 14x only because the runner awaited every
// iteration and the baselines measured that microtask tick rather than
// the access — and that made them unstable: the same code measured 7x
// here and 118x on a shared CI runner. Ratios when re-based (runner
// summing hrtime samples, instances created once, a thousand rounds per
// iteration): creation ~20-35x, read ~100-150x, write ~500-800x (the mean
// carries GC pauses from 3000 recorded writes per sample); limits ~10x above
const RATIO_GUARDS = [
  ['LazyWatch creation', 'Plain object creation', 300],
  ['LazyWatch property read', 'Plain object property read', 1500],
  ['LazyWatch property write', 'Plain object property write', 8000],
];

// [benchmark, min ops/sec] — 250k-830k ops/sec locally when added
const FLOOR_GUARDS = [
  ['Nested object write', 20000],
  ['Array push operation', 20000],
  ['Array modification', 20000],
  ['Property deletion', 20000],
  ['Batched changes (10 props)', 20000],
  ['Patch operation', 20000],
  ['Overwrite operation', 20000],
];

/**
 * Evaluate the guards against core benchmark results.
 * @param {Array<Object>} results - Results from runCoreBenchmarks()
 * @returns {Array<string>} Human-readable failure descriptions (empty = pass)
 */
export function checkCoreRegressions(results) {
  const byName = new Map(results.map(r => [r.name, parseFloat(r.opsPerSecond)]));
  const failures = [];

  console.log('\n=== Performance Regression Guard ===\n');

  for (const [name, baseline, maxRatio] of RATIO_GUARDS) {
    const ops = byName.get(name);
    const base = byName.get(baseline);
    if (!ops || !base) {
      failures.push(`ratio guard "${name}" vs "${baseline}": benchmark result missing`);
      console.log(`FAIL  ${name}: result missing`);
      continue;
    }
    const ratio = base / ops;
    const ok = ratio <= maxRatio;
    console.log(`${ok ? ' ok ' : 'FAIL'}  ${name}: ${ratio.toFixed(1)}x slower than ${baseline} (limit ${maxRatio}x)`);
    if (!ok) {
      failures.push(
        `"${name}" is ${ratio.toFixed(1)}x slower than "${baseline}" (limit ${maxRatio}x)`);
    }
  }

  for (const [name, minOps] of FLOOR_GUARDS) {
    const ops = byName.get(name);
    if (!ops) {
      failures.push(`floor guard "${name}": benchmark result missing`);
      console.log(`FAIL  ${name}: result missing`);
      continue;
    }
    const ok = ops >= minOps;
    console.log(`${ok ? ' ok ' : 'FAIL'}  ${name}: ${Math.round(ops).toLocaleString('en-US')} ops/sec (floor ${minOps.toLocaleString('en-US')})`);
    if (!ok) {
      failures.push(
        `"${name}" ran at ${Math.round(ops).toLocaleString('en-US')} ops/sec, below the ${minOps.toLocaleString('en-US')} floor`);
    }
  }

  console.log();
  return failures;
}
