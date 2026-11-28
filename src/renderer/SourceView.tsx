// SPDX-License-Identifier: AGPL-3.0-or-later
// The source view: the message's MIME structure as a tree, built only from
// what main hands over (types, charsets, cleaned names, sizes), and the raw
// headers of the message or of the selected part. The header text is mail
// data: it shows in the sandboxed body frame, never in the shell.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { SourceNode } from '../shared/api';
import { BODY_IFRAME_REFERRER, BODY_IFRAME_SANDBOX } from '../shared/constants';
import { displayText } from '../shared/header-text';
import type { MessageHeaders } from '../shared/reader-protocol';
import { copyHeaders, leaveSource, selectPart, type SourceState } from './reader';
import { fileSize, senderOf, shortDate } from './reader-format';
import './source-view.css';

/** Row height of the tree. */
const ROW = 26;
/** Past this many parts, only the rows in view and a few around them are made. */
const VIRTUAL_AFTER = 50;
const OVERSCAN = 8;
/** How long "Headers copied." stays. */
const NOTE_MS = 2500;

interface Row {
  node: SourceNode;
  depth: number;
}

/** The parts in tree order (they come depth-first), each with its depth. */
function rowsOf(parts: readonly SourceNode[]): Row[] {
  const depth: number[] = [];
  return parts.map((node, i) => {
    depth[i] = node.parent < 0 ? 0 : (depth[node.parent] ?? 0) + 1;
    return { node, depth: depth[i]! };
  });
}

function TreeRow({
  row,
  index,
  selected,
  focused,
  top,
  onSelect,
}: {
  row: Row;
  index: number;
  selected: boolean;
  focused: boolean;
  top: number | null;
  onSelect: (index: number) => void;
}) {
  const { node, depth } = row;
  const extension = node.risky ? /\.[^.]+$/.exec(node.name)?.[0] : undefined;
  return (
    <div
      className={selected ? 'sv-node sv-selected' : 'sv-node'}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      data-index={index}
      data-path={node.path}
      style={{
        paddingLeft: 8 + depth * 14,
        ...(top === null ? {} : { position: 'absolute', top, left: 0, right: 0 }),
      }}
      onClick={() => onSelect(index)}
    >
      <span className="sv-ct">{node.type}</span>
      {node.charset !== null && <span className="sv-tag">{node.charset}</span>}
      {node.inline && <span className="sv-tag">inline</span>}
      {node.name !== '' && !node.risky && <span className="sv-tag sv-name">{node.name}</span>}
      {node.risky && <span className="sv-tag sv-danger">{extension ?? node.name}</span>}
      <span className="sv-sz">{node.cut ? 'cut' : fileSize(node.size)}</span>
    </div>
  );
}

/** The tree: a flat, virtualized list with tree semantics and arrow keys. */
function Tree({ parts, selected }: { parts: readonly SourceNode[]; selected: string }) {
  const rows = useMemo(() => rowsOf(parts), [parts]);
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(ROW * 12);
  const selectedIndex = Math.max(
    0,
    rows.findIndex((r) => r.node.path === selected),
  );
  const [focus, setFocus] = useState(selectedIndex);
  const virtual = rows.length > VIRTUAL_AFTER;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight || ROW * 12));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The focused row is kept in view, then given focus once it is made.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const rowTop = focus * ROW;
    if (rowTop < el.scrollTop) el.scrollTop = rowTop;
    else if (rowTop + ROW > el.scrollTop + el.clientHeight) {
      el.scrollTop = rowTop + ROW - el.clientHeight;
    }
    setTop(el.scrollTop);
    const target = el.querySelector<HTMLElement>(`[data-index="${focus}"]`);
    if (target && el.contains(document.activeElement)) target.focus();
  }, [focus]);

  const choose = (index: number) => {
    const row = rows[index];
    if (!row) return;
    setFocus(index);
    void selectPart(row.node.path);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const move: Record<string, number> = {
      ArrowDown: focus + 1,
      ArrowUp: focus - 1,
      Home: 0,
      End: rows.length - 1,
      PageDown: focus + Math.max(1, Math.floor(height / ROW) - 1),
      PageUp: focus - Math.max(1, Math.floor(height / ROW) - 1),
    };
    if (event.key in move) {
      event.preventDefault();
      setFocus(Math.min(rows.length - 1, Math.max(0, move[event.key]!)));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(focus);
    }
  };

  const first = virtual ? Math.max(0, Math.floor(top / ROW) - OVERSCAN) : 0;
  const end = virtual
    ? Math.min(rows.length, Math.ceil((top + height) / ROW) + OVERSCAN)
    : rows.length;
  // The focused row is always made, so focus never falls out of the tree.
  const indexes: number[] = [];
  for (let i = first; i < end; i += 1) indexes.push(i);
  if (virtual && (focus < first || focus >= end)) indexes.push(focus);

  return (
    <div
      ref={box}
      className="sv-tree"
      role="tree"
      aria-label="MIME structure"
      onKeyDown={onKey}
      onScroll={virtual ? (e) => setTop(e.currentTarget.scrollTop) : undefined}
    >
      <div style={virtual ? { position: 'relative', height: rows.length * ROW } : undefined}>
        {indexes.map((i) => (
          <TreeRow
            key={rows[i]!.node.path}
            row={rows[i]!}
            index={i}
            selected={rows[i]!.node.path === selected}
            focused={i === focus}
            top={virtual ? i * ROW : null}
            onSelect={choose}
          />
        ))}
      </div>
    </div>
  );
}

export function SourceView({
  source,
  headers,
}: {
  source: SourceState;
  headers: MessageHeaders | null;
}) {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);
  const sender = headers ? senderOf(headers.from) : null;
  // Cleaned like the reader's header: by name, else by address.
  const subject = headers ? displayText(headers.subject) : '';
  const name = sender ? displayText(sender.name) || displayText(sender.address) : '';
  return (
    <div className="sv">
      <aside className="sv-left">
        <button type="button" className="btn ghost sv-back" onClick={() => void leaveSource()}>
          Back to message
        </button>
        {subject !== '' && <div className="sv-subject">{subject}</div>}
        {headers && sender && (
          <div className="sv-who">
            <span className="sv-sender">{name}</span>
            {headers.date !== null && ` · ${shortDate(headers.date)}`}
          </div>
        )}
        <div className="sv-h">MIME structure</div>
        {source.parts !== null && <Tree parts={source.parts} selected={source.selected} />}
      </aside>
      <section className="sv-right">
        <div className="sv-bar">
          <h2>Raw headers</h2>
          <button
            type="button"
            className="btn"
            disabled={source.url === null}
            onClick={() =>
              void copyHeaders().then((r) => {
                if (r.ok) setNote('Headers copied.');
              })
            }
          >
            Copy headers
          </button>
          {note !== null && (
            <span className="sv-note" role="status">
              {note}
            </span>
          )}
        </div>
        <div className="sv-body">
          {source.url !== null && (
            <iframe
              key={source.url}
              className="sv-frame"
              title="Raw headers"
              sandbox={BODY_IFRAME_SANDBOX}
              referrerPolicy={BODY_IFRAME_REFERRER}
              src={source.url}
            />
          )}
        </div>
      </section>
    </div>
  );
}
