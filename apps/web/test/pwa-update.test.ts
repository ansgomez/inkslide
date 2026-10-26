// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from '../src/pwa';

/** A ServiceWorker stand-in whose state can be advanced. */
class FakeWorker extends EventTarget {
  constructor(public state: ServiceWorkerState) { super(); }
  postMessage = vi.fn();
  to(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

/** navigator.serviceWorker and its registration, as far as pwa.ts uses them. */
function fakeContainer(opts: { controller?: boolean; active?: boolean; waiting?: boolean } = {}) {
  const active = opts.active ? new FakeWorker('activated') : null;
  const reg = Object.assign(new EventTarget(), {
    active, installing: null as FakeWorker | null, waiting: opts.waiting ? new FakeWorker('installed') : null,
    update: vi.fn(async () => {}),
  });
  const sw = Object.assign(new EventTarget(), {
    controller: opts.controller ? active : null,
    register: vi.fn(async () => reg),
  });
  /** A newer build found: it installs and waits. */
  const install = (): FakeWorker => {
    const w = new FakeWorker('installing');
    reg.installing = w;
    reg.dispatchEvent(new Event('updatefound'));
    w.to('installed');
    reg.installing = null;
    reg.waiting = w;
    return w;
  };
  return { sw: sw as unknown as ServiceWorkerContainer, reg, install };
}

const actions = () => [...document.querySelectorAll<HTMLButtonElement>('.ann-banner .ink-banner-action')];
const settle = () => new Promise(r => setTimeout(r, 0));

afterEach(() => {
  document.body.replaceChildren();
});

describe('service worker updates', () => {
  it('the first install offers nothing', async () => {
    const f = fakeContainer();
    await registerServiceWorker(async () => true, f.sw, vi.fn());
    f.install();
    expect(actions()).toHaveLength(0);
  });

  it('offers an update on a page the worker does not control (hard reload)', async () => {
    const f = fakeContainer({ active: true, waiting: true });
    await registerServiceWorker(async () => true, f.sw, vi.fn());
    expect(actions().map(b => b.textContent)).toEqual(['Reload to update']);
  });

  it('offers the update again when the user keeps the unsaved notes', async () => {
    const f = fakeContainer({ controller: true, active: true });
    await registerServiceWorker(async () => false, f.sw, vi.fn());
    const w = f.install();
    actions()[0].click();
    await settle();
    expect(w.postMessage).not.toHaveBeenCalled();
    expect(actions().map(b => b.textContent)).toEqual(['Reload to update']);
  });

  it('"updated in another window" stays when the user keeps the unsaved notes', async () => {
    const f = fakeContainer({ controller: true, active: true });
    const reload = vi.fn();
    await registerServiceWorker(async () => false, f.sw, reload);
    f.sw.dispatchEvent(new Event('controllerchange'));
    actions()[0].click();
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(actions().map(b => b.textContent)).toEqual(['Reload']);
  });

  it('a newer version replaces the offer of the one before', async () => {
    const f = fakeContainer({ controller: true, active: true });
    await registerServiceWorker(async () => true, f.sw, vi.fn());
    const older = f.install();
    const newer = f.install();
    expect(actions()).toHaveLength(1);
    actions()[0].click();
    await settle();
    expect(older.postMessage).not.toHaveBeenCalled();
    expect(newer.postMessage).toHaveBeenCalledWith('skip-waiting');
  });
});
