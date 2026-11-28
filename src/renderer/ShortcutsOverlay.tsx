// SPDX-License-Identifier: AGPL-3.0-or-later
// The keyboard shortcuts overlay: a modal over whatever shows, which stays
// mounted under it. Escape or `?` closes it (the shortcut dispatch handles
// both), and focus goes back to where it was.

import { Fragment, useEffect, useRef, type KeyboardEvent } from 'react';
import { OVERLAY_CLASS, closeShortcuts } from './shortcut-actions';
import './shortcuts.css';

const LINES: ReadonlyArray<{ keys: ReadonlyArray<ReadonlyArray<string>>; text: string }> = [
  { keys: [['j', 'k']], text: 'Next / previous conversation' },
  { keys: [['n', 'p']], text: 'Next / previous message' },
  { keys: [['/']], text: 'Search' },
  { keys: [['o', 'Enter']], text: 'Open message' },
  { keys: [['Esc']], text: 'Back / close' },
  { keys: [['u']], text: 'Toggle plain text' },
  {
    keys: [
      ['g', 'i'],
      ['g', 'a'],
    ],
    text: 'Go to Inbox · All Mail',
  },
  { keys: [['?']], text: 'Shortcuts' },
];

function Keys({ groups }: { groups: ReadonlyArray<ReadonlyArray<string>> }) {
  return (
    <span className="keys">
      {groups.map((group, g) => (
        <Fragment key={g}>
          {g > 0 && ' · '}
          {group.map((key, k) => (
            <Fragment key={k}>
              {k > 0 && ' '}
              <kbd>{key}</kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function ShortcutsOverlay() {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  // Focus moves into the overlay, and back to where it was when it closes,
  // if that is still on screen.
  useEffect(() => {
    const before = document.activeElement;
    close.current?.focus();
    return () => {
      if (
        before instanceof HTMLElement &&
        before.isConnected &&
        before.closest('[hidden], [inert]') === null
      ) {
        before.focus();
      }
    };
  }, []);

  // Focus stays in the overlay while it's open.
  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>('button')];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="shortcuts-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeShortcuts();
      }}
    >
      <div
        ref={dialog}
        className={OVERLAY_CLASS}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onKeyDown={trap}
      >
        <div className="shortcuts-head">
          <h3 id="shortcuts-title">Keyboard shortcuts</h3>
          <button
            ref={close}
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={closeShortcuts}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="shortcuts-grid">
          {LINES.map((line) => (
            <Fragment key={line.text}>
              <Keys groups={line.keys} />
              <span>{line.text}</span>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
