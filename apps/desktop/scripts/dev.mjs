// Start Electron against the Vite dev server (INKSLIDE_DEV_URL, default http://localhost:5173).
// Waits up to a minute for the server, so `pnpm dev` at the root can start both at once.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, INKSLIDE_DEV_URL: process.env.INKSLIDE_DEV_URL || 'http://localhost:5173' };
const url = env.INKSLIDE_DEV_URL;
for (let waited = 0; ; waited += 250) {
  try { await fetch(url); break; } catch { /* not up yet */ }
  if (waited === 2000) console.log(`Waiting for the dev server at ${url} (pnpm --filter @inkslide/web dev)…`);
  if (waited >= 60_000) { console.error(`No dev server at ${url}.`); process.exit(1); }
  await new Promise(r => setTimeout(r, 250));
}
const child = spawn(electron, [root, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
