import * as fs from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readJson, writeJson } from '../src/main/jsonStore';
import { tempDir } from './helpers';

/** The fs calls writeJson makes, in order (the real ones run too). */
const calls: string[] = [];
vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>();
  const spy = <K extends 'fsyncSync' | 'renameSync' | 'closeSync'>(name: K) =>
    ((...args: unknown[]) => {
      calls.push(name);
      return (real[name] as (...a: unknown[]) => unknown)(...args);
    }) as (typeof real)[K];
  return { ...real, fsyncSync: spy('fsyncSync'), closeSync: spy('closeSync'), renameSync: spy('renameSync') };
});

describe('writeJson', () => {
  it('flushes the temp file to disk before renaming it over the file', () => {
    const file = join(tempDir(), 'state.json');
    calls.length = 0;
    writeJson(file, { a: 1 });
    expect(calls).toEqual(['fsyncSync', 'closeSync', 'renameSync']);
    expect(readJson(file)).toEqual({ a: 1 });
    expect(fs.readdirSync(join(file, '..'))).toEqual(['state.json']);
  });

  it('leaves no temp file when the rename fails', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    fs.mkdirSync(join(file, 'blocker'), { recursive: true }); // a non-empty folder where the file should be
    expect(() => writeJson(file, { a: 1 })).not.toThrow();
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
  });
});
