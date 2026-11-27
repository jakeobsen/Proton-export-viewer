// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader pane: one message with its sender, date and recipients, the
// plain text and HTML switch, the body frame, and the lines for blocked
// images, size limits and the fallback.

import { useState } from 'react';
import type { RejectCode } from '../shared/api';
import { BODY_IFRAME_REFERRER, BODY_IFRAME_SANDBOX } from '../shared/constants';
import type { MessageHeaders } from '../shared/reader-protocol';
import {
  avatarColor,
  blockedImages,
  fullDate,
  initialsOf,
  senderOf,
  shortDate,
} from './reader-format';
import { openInReader, useReaderState, type ReaderView } from './reader';
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
  return (
    <>
      {headers.subject !== '' && (
        <div className="rp-head">
          <h1 className="rp-subject">{headers.subject}</h1>
        </div>
      )}
      <div className="rp-sender">
        <span
          className="rp-avatar"
          style={{ background: avatarColor(sender.address || sender.name) }}
          aria-hidden="true"
        >
          {initialsOf(sender.name)}
        </span>
        <span className="rp-name">{sender.name}</span>
        <span className="rp-date">{shortDate(headers.date)}</span>
      </div>
    </>
  );
}

function Who({ headers }: { headers: MessageHeaders }) {
  const [details, setDetails] = useState(false);
  const sender = senderOf(headers.from);
  const recipients = [headers.to, headers.cc].filter((r) => r !== '').join(', ');
  return (
    <div className="rp-who">
      {sender.address !== '' && sender.address !== sender.name && (
        <span className="rp-addr">&lt;{sender.address}&gt;</span>
      )}
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
          <dd>{headers.from}</dd>
          {headers.to !== '' && (
            <>
              <dt>To</dt>
              <dd>{headers.to}</dd>
            </>
          )}
          {headers.cc !== '' && (
            <>
              <dt>Cc</dt>
              <dd>{headers.cc}</dd>
            </>
          )}
          {headers.date !== null && (
            <>
              <dt>Date</dt>
              <dd>{fullDate(headers.date)}</dd>
            </>
          )}
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
      {view.truncated && (
        <div className="rp-line rp-truncated">
          <b>First 1 MB shown</b>
        </div>
      )}
    </>
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
 * `frameHeight` gives the body a fixed height (a card's pane-high frame);
 * without it, the body fills the pane.
 */
export function MessageBody({ frameHeight }: { frameHeight?: number }) {
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
      </div>
      {view && <Who headers={view.headers} />}
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
        </div>
      )}
      <div
        className="rp-body"
        style={frameHeight === undefined ? undefined : { height: frameHeight, flex: 'none' }}
      >
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
