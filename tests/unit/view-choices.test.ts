// SPDX-License-Identifier: AGPL-3.0-or-later
// Which view the body switch, and `u`, can ask for: never while an open is
// under way or for the view already shown, and HTML only when the message has
// it and this open didn't keep it back.

import { describe, expect, it } from 'vitest';
import { viewChoices, type ReaderState, type ReaderView } from '../../src/renderer/reader';

const BASE: ReaderState = {
  rowid: 1,
  mode: 'html',
  pending: false,
  view: null,
  fallback: false,
  fileRefused: false,
  refused: null,
  remote: { asking: false, allowed: false, failed: false, reloads: 0, insecure: 0, refused: 0 },
  openId: 1,
  source: null,
  queryId: null,
  match: null,
};

const view = (format: 'html' | 'plain', hasHtml: boolean) =>
  ({ format, hasHtml }) as unknown as ReaderView;

describe('viewChoices', () => {
  it('offers plain text on HTML, and HTML on plain text asked for', () => {
    expect(viewChoices({ ...BASE, view: view('html', true) })).toEqual({
      plain: true,
      html: false,
    });
    expect(viewChoices({ ...BASE, mode: 'plain', view: view('plain', true) })).toEqual({
      plain: false,
      html: true,
    });
  });

  it('offers no HTML the message lacks, or that this open kept back', () => {
    expect(viewChoices({ ...BASE, mode: 'plain', view: view('plain', false) })).toEqual({
      plain: false,
      html: false,
    });
    // HTML was asked for and plain text came back.
    expect(viewChoices({ ...BASE, mode: 'html', view: view('plain', true) })).toEqual({
      plain: false,
      html: false,
    });
    expect(viewChoices({ ...BASE, mode: 'html-anyway', view: view('plain', true) })).toEqual({
      plain: false,
      html: false,
    });
  });

  it('offers nothing while an open is under way', () => {
    expect(viewChoices({ ...BASE, pending: true })).toEqual({ plain: false, html: false });
    expect(viewChoices({ ...BASE, pending: true, view: view('html', true) })).toEqual({
      plain: false,
      html: false,
    });
    expect(
      viewChoices({ ...BASE, pending: true, mode: 'plain', view: view('plain', true) }),
    ).toEqual({ plain: false, html: false });
  });

  it('offers plain text on the fallback of an HTML open, and no HTML', () => {
    expect(viewChoices({ ...BASE, fallback: true })).toEqual({ plain: true, html: false });
  });
});
