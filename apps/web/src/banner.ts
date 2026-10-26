/* Inkslide web - message banners (styles: .ann-banner* in toolbar.css) */

/** Look of a banner; errors stay until closed. */
export type BannerKind = 'info' | 'warn' | 'error';

/** What a banner can do besides showing its text. */
export interface BannerOptions {
  /**
   * A button in the banner; clicking it runs `run` and closes the banner, unless `run`
   * returns false or a promise of false (e.g. the user declined a question it asked).
   */
  action?: { label: string; run(): void | boolean | Promise<boolean> };
  /** The user closed the banner with its ×, or it timed out (not called for the action). */
  onClose?(): void;
}

let box: HTMLDivElement | null = null;

/** Show a dismissable message; info banners close by themselves after `ms`. */
export function banner(text: string, kind: BannerKind = 'info', ms = kind === 'info' ? 4000 : 0, opts: BannerOptions = {}): () => void {
  if (!box || !box.isConnected) {
    box = document.createElement('div');
    box.className = 'ann-banners';
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `ann-banner ann-banner-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const msg = document.createElement('span');
  msg.className = 'ann-banner-text';
  msg.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ann-banner-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  const remove = (): void => el.remove();
  const dismiss = (): void => {
    if (!el.isConnected) return;
    remove();
    opts.onClose?.();
  };
  close.addEventListener('click', dismiss);
  el.append(msg);
  if (opts.action) {
    const { label, run } = opts.action;
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'ink-banner-action';
    act.textContent = label;
    act.addEventListener('click', () => {
      const result = run();
      if (!(result instanceof Promise)) {
        if (result !== false) remove();
        return;
      }
      act.disabled = true;
      const done = (keep: boolean): void => { act.disabled = false; if (!keep) remove(); };
      result.then(ok => done(ok === false), () => done(true));
    });
    el.append(act);
  }
  el.append(close);
  box.appendChild(el);
  if (ms > 0) setTimeout(dismiss, ms);
  return remove;
}
