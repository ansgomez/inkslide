/* Test helpers of presenter mode in the browser: a stand-in BroadcastChannel and timers. */
import type { LinkPort, LinkTimers } from '../src/presenter-link';

/** A stand-in BroadcastChannel: messages reach every other port when run() delivers them (in order). */
export function bus() {
  const ports: { fn: ((d: unknown) => void) | null }[] = [];
  let queue: { from: object; data: unknown }[] = [];
  return {
    port(): LinkPort {
      const me = { fn: null as ((d: unknown) => void) | null };
      ports.push(me);
      let closed = false;
      return {
        post: m => { if (!closed) queue.push({ from: me, data: structuredClone(m) }); },
        listen: fn => { me.fn = fn; },
        close: () => { closed = true; me.fn = null; },
      };
    },
    /** Deliver until no message is left. */
    run() {
      while (queue.length) {
        const run = queue;
        queue = [];
        for (const { from, data } of run) for (const p of ports) if (p !== from && p.fn) p.fn(data);
      }
    },
    /** Post raw data as another window would. */
    inject(data: unknown) { queue.push({ from: {}, data }); },
  };
}

/** Timeouts run by hand with fire(). */
export function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: LinkTimers = {
    setTimeout(fn, ms) { pending.set(next, { fn, ms }); return next++; },
    clearTimeout(id) { pending.delete(id as number); },
  };
  return {
    timers,
    pending: () => [...pending.values()].map(t => t.ms),
    fire() { const run = [...pending.values()]; pending.clear(); run.forEach(t => t.fn()); },
    /** Run only the timeouts of `ms` pending now. */
    fireMs(ms: number) {
      const run = [...pending].filter(([, t]) => t.ms === ms);
      for (const [id] of run) pending.delete(id);
      run.forEach(([, t]) => t.fn());
    },
  };
}


/**
 * A stand-in for navigator.locks shared by the pages of a test: `client(id)`
 * is one page's view of it; release(id) drops that page's locks (it closed).
 */
export function fakeLocks() {
  const held = new Map<string, string>(); // lock name -> client id
  return {
    held,
    /** `query`: false for a browser whose locks cannot be queried. */
    client: (clientId: string, query = true) => ({
      request: async (name: string, _options: { ifAvailable: true }, callback: (lock: unknown) => unknown) => {
        if (held.has(name)) return callback(null);
        held.set(name, clientId);
        return callback({ name });
      },
      ...(query ? { query: async () => ({ held: [...held].map(([name, c]) => ({ name, clientId: c })) }) } : {}),
    }),
    release(clientId: string) { for (const [name, c] of [...held]) if (c === clientId) held.delete(name); },
  };
}
