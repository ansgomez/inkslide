import { describe, expect, it } from 'vitest';
import { OpenRequests } from '../src/main/openRequests';

describe('OpenRequests', () => {
  it('hands the first request to initialPath() and queues the others', () => {
    const o = new OpenRequests();
    o.add('/a.pdf');
    o.add('/b.pdf');
    expect(o.takeInitial()).toBe('/a.pdf');
    expect(o.takeInitial()).toBeNull();
    expect(o.takeQueued()).toEqual(['/b.pdf']);
    expect(o.takeQueued()).toEqual([]);
  });

  it('queues a request that comes after the page asked for initialPath()', () => {
    const o = new OpenRequests();
    expect(o.takeInitial()).toBeNull(); // started without a file
    o.add('/late.pdf'); // e.g. a double click while the page still loads
    expect(o.takeQueued()).toEqual(['/late.pdf']);
  });

  it('offers initialPath() again to the next page', () => {
    const o = new OpenRequests();
    o.takeInitial();
    o.newPage();
    o.add('/next.pdf');
    expect(o.takeInitial()).toBe('/next.pdf');
  });

  it('offers a reloaded page the PDF it showed, unless another was requested', () => {
    const o = new OpenRequests();
    o.takeInitial();
    o.newPage('/shown.pdf');
    expect(o.takeInitial()).toBe('/shown.pdf');
    o.add('/requested.pdf'); // queued: the page had asked already
    o.newPage('/shown.pdf');
    expect(o.takeInitial()).toBeNull();
    expect(o.takeQueued()).toEqual(['/requested.pdf']);
  });
});
