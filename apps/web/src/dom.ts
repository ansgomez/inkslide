/* Inkslide web - small browser helpers shared by the modules */

/** localStorage item; null when missing or storage is blocked (private mode, sandbox). */
export function storedItem(key: string): string | null {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

/** Set (or with null remove) a localStorage item; nothing when storage is blocked or full. */
export function storeItem(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (_) { /* a convenience only */ }
}
