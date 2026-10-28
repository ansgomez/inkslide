import { describe, expect, it } from 'vitest';
import { PrintGate } from '../src/main/print';

describe('PrintGate', () => {
  it('runs one print at a time per window, refusing the others at once', async () => {
    const gate = new PrintGate();
    const win = {};
    const other = {};
    let finish!: (ok: boolean) => void;
    const first = gate.run(win, () => new Promise<boolean>(r => { finish = r; }));
    await expect(gate.run(win, async () => true)).rejects.toThrow(/already in progress/);
    await expect(gate.run(other, async () => true)).resolves.toBe(true); // another window
    finish(true);
    await expect(first).resolves.toBe(true);
    await expect(gate.run(win, async () => false)).resolves.toBe(false); // free again
  });
  it('is free again after a print that failed', async () => {
    const gate = new PrintGate();
    const win = {};
    await expect(gate.run(win, async () => { throw new Error('printing failed'); })).rejects.toThrow('printing failed');
    await expect(gate.run(win, async () => true)).resolves.toBe(true);
  });
});
