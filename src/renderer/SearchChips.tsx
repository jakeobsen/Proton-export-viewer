// SPDX-License-Identifier: AGPL-3.0-or-later
// The chip row under the results' count and sort: the search's chips, each
// with its remove button, and the buttons that add one. A chip is data, never
// query text; names are shown as text, isolated from the text around them.

import { useState, type KeyboardEvent } from 'react';
import { cleanQuery, hasWord } from '../shared/query-text';
import { MAX_CHIPS, MAX_FROM_LENGTH, isRealDay } from '../shared/search-chips';
import type { SidebarEntry, SidebarModel } from './folders';
import { addSearchChip, removeSearchChip, useSearch } from './mailbox-state';
import { chipText, folderChoices, labelChoices } from './search-chips';

type Adding = 'from' | 'after' | 'label' | 'folder' | null;

/** Keys in a chip's field stay there: Esc closes the field, not the search. */
function fieldKeys(e: KeyboardEvent<HTMLInputElement>, add: () => void, close: () => void): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    add();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
  }
}

function FromField({ close }: { close: () => void }) {
  const [value, setValue] = useState('');
  return (
    <input
      className="chip-field"
      type="text"
      aria-label="From"
      spellCheck={false}
      autoComplete="off"
      autoFocus
      maxLength={MAX_FROM_LENGTH}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={close}
      onKeyDown={(e) =>
        fieldKeys(
          e,
          () => {
            // A value with no word to match adds nothing.
            if (!hasWord(cleanQuery(value))) return;
            addSearchChip({ k: 'from', v: value });
            close();
          },
          close,
        )
      }
    />
  );
}

function AfterField({ close }: { close: () => void }) {
  const [value, setValue] = useState('');
  return (
    <input
      className="chip-field"
      type="date"
      aria-label="After"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={close}
      onKeyDown={(e) =>
        fieldKeys(
          e,
          () => {
            if (!isRealDay(value)) return;
            addSearchChip({ k: 'after', d: value });
            close();
          },
          close,
        )
      }
    />
  );
}

/** The labels or folders a chip can be made from, in sidebar order. */
function ChoiceList({
  label,
  entries,
  pick,
  close,
}: {
  label: string;
  entries: SidebarEntry[];
  pick: (id: string) => void;
  close: () => void;
}) {
  return (
    <div
      className="chip-choices"
      role="listbox"
      aria-label={label}
      data-keeps-keys=""
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="option"
          aria-selected={false}
          className="chip-choice"
          data-id={entry.id}
          onClick={() => pick(entry.id)}
        >
          {entry.kind === 'label' && (
            <span className="dot" style={{ background: entry.color ?? undefined }} />
          )}
          <span className="chip-name" dir="auto">
            {entry.name}
          </span>
        </button>
      ))}
    </div>
  );
}

export function ChipRow({ sidebar }: { sidebar: SidebarModel | null }) {
  const { chips } = useSearch();
  const [adding, setAdding] = useState<Adding>(null);
  const has = (k: string) => chips.some((c) => c.k === k);
  const full = chips.length >= MAX_CHIPS;
  const close = () => setAdding(null);
  const toggle = (what: Adding) => setAdding((now) => (now === what ? null : what));
  // A button whose list is open keeps its keys, and Esc there closes the list.
  const opener = (what: 'label' | 'folder') => ({
    'aria-expanded': adding === what,
    'data-keeps-keys': adding === what ? '' : undefined,
    onClick: () => toggle(what),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Escape' && adding === what) {
        e.stopPropagation();
        close();
      }
    },
  });
  const pick = (k: 'label' | 'folder') => (id: string) => {
    addSearchChip({ k, id });
    close();
  };
  return (
    <div className="search-chips" role="group" aria-label="Filters">
      {chips.map((chip, i) => (
        <span key={`${chip.k}:${i}`} className="chip search-chip" data-kind={chip.k}>
          <span className="chip-name" dir="auto">
            {chipText(chip, sidebar) ?? ''}
          </span>
          <button
            type="button"
            className="chip-remove"
            aria-label="Remove filter"
            onClick={() => removeSearchChip(i)}
          >
            ×
          </button>
        </span>
      ))}
      {!full && (
        <>
          {!has('from') &&
            (adding === 'from' ? (
              <FromField close={close} />
            ) : (
              <button type="button" className="chip-add" onClick={() => toggle('from')}>
                From: …
              </button>
            ))}
          {!has('attachment') && (
            <button
              type="button"
              className="chip-add"
              onClick={() => addSearchChip({ k: 'attachment' })}
            >
              Has attachment
            </button>
          )}
          {!has('after') &&
            (adding === 'after' ? (
              <AfterField close={close} />
            ) : (
              <button type="button" className="chip-add" onClick={() => toggle('after')}>
                After …
              </button>
            ))}
          <button type="button" className="chip-add" {...opener('label')}>
            + Label
          </button>
          <button type="button" className="chip-add" {...opener('folder')}>
            + Folder
          </button>
          {!has('unread') && (
            <button
              type="button"
              className="chip-add"
              onClick={() => addSearchChip({ k: 'unread' })}
            >
              Unread
            </button>
          )}
        </>
      )}
      {adding === 'label' && !full && (
        <ChoiceList
          label="Labels"
          entries={labelChoices(sidebar)}
          pick={pick('label')}
          close={close}
        />
      )}
      {adding === 'folder' && !full && (
        <ChoiceList
          label="Folders"
          entries={folderChoices(sidebar)}
          pick={pick('folder')}
          close={close}
        />
      )}
    </div>
  );
}
