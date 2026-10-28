/* Inkslide desktop - locking down windows: no Node, no navigation, no permissions
 *
 * Used by the app window, the audience window of presenter mode and the
 * hidden print window. Pages never navigate or open windows (only the app
 * window passes http(s) links on to the system browser, after the user
 * confirms each, confirmLinks); the only permission
 * granted (asked for or checked) is fullscreen. Without a check handler Electron answers every permission check
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

/** Longest link offered to the browser: real ones are far shorter, and the dialog shows all of it. */
export const MAX_LINK_LENGTH = 2048;

/**
 * The app window's `openLink` for lockNavigation: `ask` the user first, then
 * `open` the link. The page cannot prove that a link comes from a click, and
 * a compromised page could send the notes out in a URL, so every link is
 * confirmed in a native dialog that shows its host and the whole URL. One
 * question at a time: links that come while it is asked are dropped, as are
 * links that are not http(s) or longer than MAX_LINK_LENGTH.
 */
export function confirmLinks(ask: (url: URL) => Promise<boolean>, open: (url: string) => void): (url: string) => void {
  let asking = false;
  return url => {
    if (asking || url.length > MAX_LINK_LENGTH || !URL.canParse(url)) return;
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    asking = true;
    void ask(u).then(ok => { if (ok) open(u.href); }, () => {}).finally(() => { asking = false; });
  };
}

/** Whether pages of the app get `permission`. */
const permissionAllowed = (permission: string): boolean => permission === 'fullscreen';

/** Grant only fullscreen, to requests and to checks. */
export function restrictPermissions(session: Session): void {
  session.setPermissionRequestHandler((_wc, permission, cb) => cb(permissionAllowed(permission)));
  session.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission));
}
