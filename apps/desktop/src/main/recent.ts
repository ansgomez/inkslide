/* Inkslide desktop - recent files list (JSON in userData) */
import { isAbsolute, resolve } from 'node:path';
import { readJson, writeJson } from './jsonStore';

/** Longest recent files list. */
export const RECENT_MAX = 10;

/** Recently opened PDFs (absolute paths, newest first), saved to `file` on every change. */
export class RecentFiles {
  private list: string[];

  constructor(private readonly file: string, private readonly max = RECENT_MAX) {
    const data = readJson(file, []);
    this.list = Array.isArray(data)
      ? data.filter((p): p is string => typeof p === 'string' && isAbsolute(p)).slice(0, max)
      : [];
  }

  /** Paths, newest first. */
  paths(): string[] {
    return [...this.list];
  }

  has(path: string): boolean {
    return this.list.includes(resolve(path));
  }

  /** Move `path` to the front (adding it if new) and save. */
  add(path: string): void {
    const p = resolve(path);
    this.list = [p, ...this.list.filter(q => q !== p)].slice(0, this.max);
    this.save();
  }

  remove(path: string): void {
    const p = resolve(path);
    this.list = this.list.filter(q => q !== p);
    this.save();
  }

  clear(): void {
    this.list = [];
    this.save();
  }

  private save(): void {
    writeJson(this.file, this.list);
  }
}
