/* Inkslide web - small LRU cache for rendered pages
 *
 * Keeps at most `limit` entries; the least recently used one is evicted
 * and disposed (ImageBitmap.close()) when a new one comes in.
 */
export class BitmapCache<T> {
  private map = new Map<string, T>();

  constructor(readonly limit = 6, private dispose: (value: T) => void = () => {}) {}

  get size(): number { return this.map.size; }
  has(key: string): boolean { return this.map.has(key); }
  keys(): string[] { return [...this.map.keys()]; }

  /** The value, marked as most recently used; undefined if absent. */
  get(key: string): T | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  /** Latest-used value whose key passes the test (e.g. same page, other scale). */
  find(test: (key: string) => boolean): T | undefined {
    const keys = [...this.map.keys()].reverse();
    const key = keys.find(test);
    return key === undefined ? undefined : this.map.get(key);
  }

  set(key: string, value: T): void {
    const old = this.map.get(key);
    if (old !== undefined && old !== value) this.dispose(old);
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const [k, v] = this.map.entries().next().value as [string, T];
      this.map.delete(k);
      this.dispose(v);
    }
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (v === undefined) return;
    this.map.delete(key);
    this.dispose(v);
  }

  clear(): void {
    for (const v of this.map.values()) this.dispose(v);
    this.map.clear();
  }
}
