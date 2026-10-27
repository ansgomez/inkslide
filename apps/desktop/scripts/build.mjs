// Bundle the main process and the (sandboxed) preload into out/ with esbuild.
// @inkslide/annotate is TypeScript source, so it is bundled in as well.
// INKSLIDE_TEST_BUILD=1: a packaged app built from this still honors the test
// environment variables (INKSLIDE_PAGE, INKSLIDE_SMOKE, ...; main.ts), so the
// smoke test can run against the package. scripts/dist.mjs sets it only with
// --test-build (and refuses it from the shell otherwise).
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'out');
rmSync(outdir, { recursive: true, force: true });

const common = {
  bundle: true,
  define: { INKSLIDE_TEST_BUILD: JSON.stringify(process.env.INKSLIDE_TEST_BUILD === '1') },
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
};

await Promise.all([
  build({ ...common, entryPoints: { main: join(root, 'src/main/main.ts') }, outdir }),
  build({ ...common, entryPoints: { preload: join(root, 'src/preload/preload.ts') }, outdir, target: 'chrome142' }),
]);
console.log('built out/main.js, out/preload.js');
