/* Inkslide web - platform adapter selection
 *
 * Electron: window.inkslide (preload bridge). Tauri (apps/mobile): tauri.ts,
 * which loads its plugins on first use. Everywhere else (browser, PWA): the
 * web adapter.
 */
import type { PlatformAdapter } from '@inkslide/annotate';
import type { InkslideBridge } from './bridge';
import { createTauriAdapter } from './tauri';
import { createWebAdapter, type WebAdapter } from './web';

export type { InkslideBridge, MenuCommand } from './bridge';
export type AppAdapter = PlatformAdapter & {
  platform: 'electron' | 'web' | 'tauri';
  initialPath?(): Promise<string | null>;
  /** PdfFile for a File from drag and drop or a file input. */
  fromFile?(file: File): Promise<import('@inkslide/annotate').PdfFile>;
  pathForFile?(file: File): string;
  /** A PDF was opened (web: remember it in the recent files). */
  opened?(file: import('@inkslide/annotate').PdfFile, info: { sha256: string; pages: number }): Promise<void>;
};

let adapter: AppAdapter | null = null;

export function getAdapter(): AppAdapter {
  if (adapter) return adapter;
  const bridge: InkslideBridge | undefined = typeof window !== 'undefined' ? window.inkslide : undefined;
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  adapter = bridge ? bridge : tauri ? createTauriAdapter() : createWebAdapter();
  return adapter;
}

export function isWebAdapter(a: PlatformAdapter): a is WebAdapter {
  return (a as AppAdapter).platform === 'web';
}
