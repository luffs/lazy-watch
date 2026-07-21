// size.js - Bundle-size budget check
//
// Bundles and minifies the library with esbuild (fetched on demand via npx,
// like the TypeScript definition check), gzips the result, and fails when
// the gzipped size exceeds the budget. Keeps the "~6.5 kB min+gzip" claim
// in the README honest: a change that blows the budget fails CI, and the
// README number should be updated whenever the printed size drifts from it.
import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

// Measured 6.5 kB at the time this check was added; the headroom allows
// normal growth while still catching an accidentally bundled dependency
// or a runaway feature.
const GZIP_BUDGET_BYTES = 8 * 1024;

const minified = execSync(
  'npx -y esbuild src/lazy-watch.js --bundle --minify --format=esm --log-level=warning',
  { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }
);
const gzipped = gzipSync(minified, { level: 9 });

const kb = bytes => `${(bytes / 1024).toFixed(2)} kB`;
console.log(`minified:  ${kb(minified.length)}`);
console.log(`min+gzip:  ${kb(gzipped.length)} (budget: ${kb(GZIP_BUDGET_BYTES)})`);

if (gzipped.length > GZIP_BUDGET_BYTES) {
  console.error(
    `\nSize budget exceeded by ${kb(gzipped.length - GZIP_BUDGET_BYTES)}. ` +
    'Either slim the change down, or — if the growth is justified — raise ' +
    'GZIP_BUDGET_BYTES in scripts/size.js and update the size claims in README.md.'
  );
  process.exit(1);
}
