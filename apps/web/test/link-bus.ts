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
  };
}

