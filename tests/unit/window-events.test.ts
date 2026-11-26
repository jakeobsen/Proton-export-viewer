// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WindowEventRecorder, type RecordedWindow } from '../../src/testhooks/window-events';

/** A stand-in for a BrowserWindow: an id and its events. */
function fakeWindow(id: number): RecordedWindow {
  return Object.assign(new EventEmitter(), { id });
}

describe('WindowEventRecorder', () => {
  it('starts with an empty record', () => {
    const recorder = new WindowEventRecorder();
    recorder.attach(fakeWindow(1));
    expect(recorder.events()).toEqual([]);
  });

  it('records each show and focus event with its window, in order', () => {
    const recorder = new WindowEventRecorder();
    const first = fakeWindow(1);
    const second = fakeWindow(2);
    recorder.attach(first);
    recorder.attach(second);
    first.emit('show');
    second.emit('focus');
    first.emit('focus');
    expect(recorder.events()).toEqual([
      { window: 1, event: 'show' },
      { window: 2, event: 'focus' },
      { window: 1, event: 'focus' },
    ]);
  });

  it('proves it is connected to a window, and keeps the probe out of the record', () => {
    const recorder = new WindowEventRecorder();
    const win = fakeWindow(7);
    recorder.attach(win);
    expect(recorder.probe(win)).toEqual([
      { window: 7, event: 'show' },
      { window: 7, event: 'focus' },
    ]);
    expect(recorder.events()).toEqual([]);
    win.emit('show');
    expect(recorder.events()).toEqual([{ window: 7, event: 'show' }]);
  });

  it('sees nothing when probing a window it is not attached to', () => {
    const recorder = new WindowEventRecorder();
    recorder.attach(fakeWindow(1));
    expect(recorder.probe(fakeWindow(2))).toEqual([]);
    expect(recorder.events()).toEqual([]);
  });

  it('records again after a probe that threw', () => {
    const recorder = new WindowEventRecorder();
    const win = fakeWindow(3);
    recorder.attach(win);
    win.on('focus', () => {
      throw new Error('listener failed');
    });
    expect(() => recorder.probe(win)).toThrow('listener failed');
    win.emit('show');
    expect(recorder.events()).toEqual([{ window: 3, event: 'show' }]);
  });

  it('returns copies of the record', () => {
    const recorder = new WindowEventRecorder();
    const win = fakeWindow(1);
    recorder.attach(win);
    win.emit('show');
    const copy = recorder.events();
    copy.length = 0;
    expect(recorder.events()).toHaveLength(1);
  });
});
