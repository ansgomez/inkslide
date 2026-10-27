/* Inkslide web - small LRU cache for rendered pages
 *
 * Keeps at most `limit` entries and, with a `weigh` function, at most
 * `maxBytes` in all (bitmaps differ a lot in size: a zoomed page can be
 * 64 MB); the least recently used ones are evicted and disposed
 * (ImageBitmap.close()) when a new one comes in. The newest entry is
 * always kept.
 */
export class BitmapCache<T> {
  private map = new Map<string, T>();
  private total = 0;

  constructor(
    readonly limit = 6,
    private dispose: (value: T) => void = () => {},
    private weigh: (value: T) => number = () => 0,
    readonly maxBytes = Infinity,
  ) {}

  get size(): number { return this.map.size; }
  /** Sum of the entries' weights. */
  get bytes(): number { return this.total; }
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
    if (old !== undefined) {
      this.total -= this.weigh(old);
      if (old !== value) this.dispose(old);
    }
    this.map.delete(key);
    this.map.set(key, value);
    this.total += this.weigh(value);
    while (this.map.size > this.limit || (this.total > this.maxBytes && this.map.size > 1)) {
      const [k, v] = this.map.entries().next().value as [string, T];
      this.map.delete(k);
      this.total -= this.weigh(v);
      this.dispose(v);
    }
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (v === undefined) return;
    this.map.delete(key);
    this.total -= this.weigh(v);
    this.dispose(v);
  }

  clear(): void {
    for (const v of this.map.values()) this.dispose(v);
    this.map.clear();
    this.total = 0;
  }
}
