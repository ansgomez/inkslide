/* Inkslide desktop - app preferences (userData/preferences.json) */
import { readJson, writeJson } from './jsonStore';

/** What the user can turn on and off in the menu. */
export interface Preferences {
  /** Copy the saved notes to a backup before a save, at most every 2 minutes (default on). */
  backups: boolean;
}

/** Preferences on first start. */
export const DEFAULT_PREFERENCES: Preferences = { backups: true };

/** Preferences from untrusted JSON; bad or missing fields get defaults. */
export function parsePreferences(data: unknown): Preferences {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  return { backups: typeof d.backups === 'boolean' ? d.backups : DEFAULT_PREFERENCES.backups };
}

export const loadPreferences = (file: string): Preferences => parsePreferences(readJson(file));
/** Save at once (a failure is logged, the setting still applies until quit). */
export const savePreferences = (file: string, prefs: Preferences): void => writeJson(file, prefs);
