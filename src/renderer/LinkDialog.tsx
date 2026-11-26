// SPDX-License-Identifier: AGPL-3.0-or-later
// The link dialog: the link's title and URL, warnings, and three choices.
// The URL is shown as main sent it; only the dialog's id goes back.

import { useEffect } from 'react';
import type { LinkPrompt } from '../shared/api';
import './link-dialog.css';
import { answerLink } from './shell';

const ICON = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

function Warning({ className, text }: { className: string; text: string }) {
  return (
    <div className={`link-alert ${className}`} role="alert">
      <svg className="link-icon" {...ICON}>
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <b>{text}</b>
    </div>
  );
}

function Url({ prompt }: { prompt: LinkPrompt }) {
  const { url, host } = prompt;
  if (host === null || host.start < 0 || host.end > url.length || host.start >= host.end) {
    return <>{url}</>;
  }
  return (
    <>
      {url.slice(0, host.start)}
      <span className="link-host">{url.slice(host.start, host.end)}</span>
      {url.slice(host.end)}
    </>
  );
}

export function LinkDialog({ prompt }: { prompt: LinkPrompt }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void answerLink('cancel');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="link-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) void answerLink('cancel');
      }}
    >
      <div
        className="link-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-dialog-title"
      >
        <div className="link-head">
          <svg className="link-icon" {...ICON} width={18} height={18}>
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <h3 id="link-dialog-title">Open link?</h3>
          <button
            type="button"
            className="link-close"
            aria-label="Close"
            onClick={() => void answerLink('cancel')}
          >
            <svg className="link-icon" {...ICON}>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="link-body">
          {prompt.title !== '' && (
            <>
              <div className="link-label">Title</div>
              <div className="link-box link-title">{prompt.title}</div>
            </>
          )}
          <div className="link-label">URL</div>
          <div className="link-box link-url">
            <Url prompt={prompt} />
          </div>
          {prompt.mismatch && <Warning className="link-mismatch" text="Title doesn't match URL" />}
          {prompt.lookalike && (
            <Warning className="link-lookalike" text="URL uses look-alike characters" />
          )}
        </div>
        <div className="link-foot">
          <button
            type="button"
            className="link-btn link-cancel"
            autoFocus
            onClick={() => void answerLink('cancel')}
          >
            Cancel
          </button>
          <button
            type="button"
            className="link-btn link-copy"
            onClick={() => void answerLink('copy')}
          >
            <svg className="link-icon" {...ICON} width={14} height={14}>
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy link
          </button>
          <button
            type="button"
            className="link-btn link-danger link-open"
            onClick={() => void answerLink('open')}
          >
            Open in browser
          </button>
        </div>
      </div>
    </div>
  );
}
