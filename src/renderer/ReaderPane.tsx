// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader pane: one message with its sender, date and recipients, the
// plain text and HTML switch, the actions on the message, the body frame, the
// lines for blocked images, size limits and the fallback, and the attachments.
// The source view of the message takes the pane's place while it shows.

import { useEffect, useMemo, useState } from 'react';
import type { AttachmentItem, RejectCode } from '../shared/api';
import { BODY_IFRAME_REFERRER, BODY_IFRAME_SANDBOX } from '../shared/constants';
import { displayText, headerText } from '../shared/header-text';
import type { MessageDetails, MessageHeaders } from '../shared/reader-protocol';
import {
  ATT_ROW,
  attachmentCount,
  attachmentRowAt,
  attachmentRowTops,
  avatarColor,
  blockedImages,
  fileSize,
  fullDate,
  initialsOf,
  senderOf,
  shortDate,
} from './reader-format';
import {
  copyMessageId,
  openInReader,
  openSource,
  showInFolder,
  useReaderState,
  type ReaderView,
} from './reader';
import { useShellState } from './shell';
import { SourceView } from './SourceView';
import './reader-pane.css';

const ICON = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

function PlainIcon() {
  return (
    <svg className="rp-icon" {...ICON}>
      <line x1="17" y1="10" x2="3" y2="10" />
      <line x1="21" y1="6" x2="3" y2="6" />
      <line x1="21" y1="14" x2="3" y2="14" />
      <line x1="17" y1="18" x2="3" y2="18" />
    </svg>
  );
}

function HtmlIcon() {
  return (
    <svg className="rp-icon" {...ICON}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function ImageOffIcon() {
  return (
    <svg className="rp-icon" {...ICON} width={16} height={16}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

function SourceIcon() {
  return (
    <svg className="rp-icon" {...ICON}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg className="rp-icon" {...ICON} width={16} height={16}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function Header({ headers }: { headers: MessageHeaders }) {
  const sender = senderOf(headers.from);
  const subject = displayText(headers.subject);
  // A name that cleans to nothing gives way to the address, as on the cards.
  const name = displayText(sender.name) || displayText(sender.address);
  return (
    <>
      {subject !== '' && (
        <div className="rp-head">
          <h1 className="rp-subject">{subject}</h1>
        </div>
      )}
      <div className="rp-sender">
        <span
          className="rp-avatar"
          style={{ background: avatarColor(sender.address || sender.name) }}
          aria-hidden="true"
        >
          {initialsOf(name)}
        </span>
        <span className="rp-name">{name}</span>
        <span className="rp-date">{shortDate(headers.date)}</span>
      </div>
    </>
  );
}

function Who({ headers, details: more }: { headers: MessageHeaders; details: MessageDetails }) {
  const [details, setDetails] = useState(false);
  const sender = senderOf(headers.from);
  const address = displayText(sender.address);
  const name = displayText(sender.name) || address;
  const recipients = displayText([headers.to, headers.cc].filter((r) => r !== '').join(', '));
  return (
    <div className="rp-who">
      {address !== '' && address !== name && <span className="rp-addr">&lt;{address}&gt;</span>}
      {recipients !== '' && <span className="rp-to">to {recipients}</span>}
      <button
        type="button"
        className="rp-linkish"
        aria-expanded={details}
        onClick={() => setDetails(!details)}
      >
        {details ? 'Hide details' : 'Details'}
      </button>
      {details && (
        <dl className="rp-details">
          <dt>From</dt>
          <dd>{headerText(headers.from)}</dd>
          {headers.to !== '' && (
            <>
              <dt>To</dt>
              <dd>{headerText(headers.to)}</dd>
            </>
          )}
          {headers.cc !== '' && (
            <>
              <dt>Cc</dt>
              <dd>{headerText(headers.cc)}</dd>
            </>
          )}
          {headers.date !== null && (
            <>
              <dt>Date</dt>
              <dd>{fullDate(headers.date)}</dd>
            </>
          )}
          {more.messageId !== '' && (
            <>
              <dt>Message-ID</dt>
              <dd className="rp-mono">{more.messageId}</dd>
            </>
          )}
          {more.references.length > 0 && (
            <>
              <dt>References</dt>
              <dd className="rp-mono">
                {more.references.map((id, i) => (
                  <div key={i}>{id}</div>
                ))}
                {more.moreReferences > 0 && <div>and {more.moreReferences} more</div>}
              </dd>
            </>
          )}
          <dt>Format</dt>
          <dd>{more.format}</dd>
        </dl>
      )}
    </div>
  );
}

function Lines({ rowid, view }: { rowid: number; view: ReaderView }) {
  return (
    <>
      {view.format === 'html' && view.remote > 0 && (
        <div className="rp-line rp-images">
          <ImageOffIcon />
          <b>{blockedImages(view.remote)}</b>
        </div>
      )}
      {view.htmlTooLarge && (
        <div className="rp-line rp-too-large">
          <button
            type="button"
            className="rp-btn"
            onClick={() => void openInReader(rowid, 'html-anyway')}
          >
            Show HTML anyway
          </button>
        </div>
      )}
      {view.cut && (
        <div className="rp-line rp-truncated">
          <b>{view.cut === 'size' ? 'First 1 MB shown' : 'Only part of this message shown'}</b>
        </div>
      )}
    </>
  );
}

/** How many plain rows high the attachment list is once virtual. */
const ATT_SHOWN = 6;
/** Past this many attachments, only the rows in view and a few around them are made. */
const ATT_VIRTUAL_AFTER = 50;
const ATT_OVERSCAN = 4;

function AttachmentRow({ item, top }: { item: AttachmentItem; top: number | null }) {
  return (
    <div
      className={item.risky ? 'rp-att rp-att-risky' : 'rp-att'}
      role="listitem"
      style={top === null ? undefined : { position: 'absolute', top, left: 0, right: 0 }}
    >
      <div className="rp-att-name">{item.name}</div>
      <div className="rp-att-meta">
        {item.label} · {fileSize(item.size)}
      </div>
      {item.risky && (
        <div className="rp-att-warn">
          <WarnIcon />
          <span>Program file. It can harm your computer.</span>
        </div>
      )}
    </div>
  );
}

function Attachments({ items }: { items: AttachmentItem[] }) {
  const [top, setTop] = useState(0);
  const virtual = items.length > ATT_VIRTUAL_AFTER;
  const tops = useMemo(
    () => (virtual ? attachmentRowTops(items.map((item) => item.risky)) : []),
    [items, virtual],
  );
  if (items.length === 0) return null;
  const height = ATT_SHOWN * ATT_ROW;
  const first = virtual ? Math.max(0, attachmentRowAt(tops, top) - ATT_OVERSCAN) : 0;
  const end = virtual
    ? Math.min(items.length, attachmentRowAt(tops, top + height) + 1 + ATT_OVERSCAN)
    : items.length;
  return (
    <section className="rp-atts" aria-label="Attachments">
      <div className="rp-att-title">{attachmentCount(items.length)}</div>
      <div
        className={virtual ? 'rp-att-list rp-att-virtual' : 'rp-att-list'}
        role="list"
        style={virtual ? { height } : undefined}
        onScroll={virtual ? (e) => setTop(e.currentTarget.scrollTop) : undefined}
      >
        <div style={virtual ? { position: 'relative', height: tops[items.length] } : undefined}>
          {items.slice(first, end).map((item) => (
            <AttachmentRow key={item.index} item={item} top={virtual ? tops[item.index]! : null} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** How long "Message-ID copied." stays. */
const NOTE_MS = 2500;

/** Show in folder and Copy Message-ID, for the message the pane shows. */
function MessageActions({ view }: { view: ReaderView }) {
  const { sources } = useShellState();
  const offline = sources?.active?.status === 'offline';
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);
  return (
    <div className="rp-acts" role="group" aria-label="Message">
      <button
        type="button"
        className="rp-act rp-show"
        disabled={offline}
        title="Show in folder"
        onClick={() => void showInFolder()}
      >
        Show in folder
      </button>
      <button
        type="button"
        className="rp-act rp-copy-id"
        disabled={view.details.messageId === ''}
        title="Copy Message-ID"
        onClick={() =>
          void copyMessageId().then((r) => {
            if (r.ok) setNote('Message-ID copied.');
          })
        }
      >
        Message-ID
      </button>
      {note !== null && (
        <span className="rp-note" role="status">
          {note}
        </span>
      )}
    </div>
  );
}

/** What the pane says when main refused the open; a newer open owns the pane otherwise. */
export function refusedText(code: RejectCode): string | null {
  switch (code) {
    case 'superseded':
    case 'stale_generation':
      return null;
    case 'eml_missing':
      return 'Message file missing';
    case 'offline':
      return 'Export not found.';
    case 'not_found':
      return 'Message no longer in the export';
    default:
      return "Couldn't render this message";
  }
}

/**
 * The open message below its header: the body switch, the recipients, the
 * state lines and the body frame, or the line that says why it can't open.
 * It fills the pane; in a card, the stylesheet makes it as high as the pane.
 */
export function MessageBody() {
  const reader = useReaderState();
  const { rowid, view, pending } = reader;
  if (rowid === null) return null;
  if (reader.refused !== null) {
    const text = refusedText(reader.refused);
    return text === null ? null : (
      <div className="rp-line rp-state" role="status">
        <b>{text}</b>
      </div>
    );
  }
  if (reader.source !== null) {
    return <SourceView source={reader.source} headers={view?.headers ?? null} />;
  }
  const shown = view?.format ?? null;
  // HTML was asked for and plain text came back: this open can't show the HTML
  // ("Show HTML anyway" is offered when its size alone kept it back).
  const htmlKeptBack = view?.format === 'plain' && reader.mode !== 'plain';
  return (
    <>
      <div className="rp-actbar" role="toolbar" aria-label="Message actions">
        <div className="rp-seg" role="group" aria-label="Body view">
          <button
            type="button"
            className="rp-plain"
            aria-pressed={shown === 'plain'}
            disabled={pending || shown === 'plain'}
            onClick={() => void openInReader(rowid, 'plain')}
          >
            <PlainIcon />
            Plain text
          </button>
          <button
            type="button"
            className="rp-html"
            aria-pressed={shown === 'html'}
            disabled={pending || shown === 'html' || !view?.hasHtml || htmlKeptBack}
            title={view && !view.hasHtml ? 'No HTML version' : undefined}
            onClick={() => void openInReader(rowid, 'html')}
          >
            <HtmlIcon />
            HTML
          </button>
        </div>
        {view && (
          <button
            type="button"
            className="rp-act rp-source"
            title="View source"
            onClick={() => void openSource()}
          >
            <SourceIcon />
            Source
          </button>
        )}
        {view && <MessageActions key={view.url} view={view} />}
      </div>
      {view && <Who headers={view.headers} details={view.details} />}
      {view && <Lines rowid={rowid} view={view} />}
      {reader.fallback && (
        <div className="rp-line rp-fallback" role="alert">
          <WarnIcon />
          <b>Couldn&apos;t render this message</b>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="rp-btn"
            onClick={() => void openInReader(rowid, 'plain')}
          >
            View as plain text
          </button>
          <span aria-hidden="true">·</span>
          <button type="button" className="rp-btn rp-view-source" onClick={() => void openSource()}>
            View source
          </button>
        </div>
      )}
      <div className="rp-body">
        {view && (
          <iframe
            key={view.url}
            className="rp-frame"
            title="Message body"
            sandbox={BODY_IFRAME_SANDBOX}
            referrerPolicy={BODY_IFRAME_REFERRER}
            src={view.url}
          />
        )}
      </div>
      {view && <Attachments key={view.url} items={view.attachments} />}
    </>
  );
}

/** One message on its own, with its subject and sender: the reader outside a conversation. */
export function ReaderPane() {
  const reader = useReaderState();
  if (reader.rowid === null) return null;
  const view = reader.refused === null ? reader.view : null;
  return (
    <div className="rp" aria-busy={reader.pending}>
      {view && <Header headers={view.headers} />}
      <MessageBody />
    </div>
  );
}
