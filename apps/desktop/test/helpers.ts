import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const dirs: string[] = [];

/** A fresh temp directory, removed after the test. */
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'inkslide-test-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});
