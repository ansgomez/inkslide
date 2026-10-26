/* Inkslide desktop - locking down windows: no Node, no navigation, no permissions
 *
 * Used by the app window and the hidden print window. Pages never navigate
 * or open windows; the only permission granted (asked for or checked) is
 * fullscreen. Without a check handler Electron answers every permission check
 * (navigator.permissions, clipboard, ...) with "granted".
 */
import type { Session, WebContents, WebPreferences } from 'electron';

/** webPreferences of every window: isolated, sandboxed, no Node. */
export const SAFE_WEB_PREFERENCES: WebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
};

/** The page cannot navigate or open windows; http(s) links it tries to open go to `openLink`. */
export function lockNavigation(wc: WebContents, openLink?: (url: string) => void): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (openLink && /^https?:\/\//i.test(url)) openLink(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', e => e.preventDefault());
}

/** Whether pages of the app get `permission`. */
const permissionAllowed = (permission: string): boolean => permission === 'fullscreen';

/** Grant only fullscreen, to requests and to checks. */
export function restrictPermissions(session: Session): void {
  session.setPermissionRequestHandler((_wc, permission, cb) => cb(permissionAllowed(permission)));
  session.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission));
}
