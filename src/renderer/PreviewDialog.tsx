// SPDX-License-Identifier: AGPL-3.0-or-later
// The attachment preview: the attachment's name, its image in a frame of its
// own, its format, size and canvas, and Close and Save. The frame shows a
// fixed document main serves under the view's token, with the body frame's
// sandbox; it takes no focus and no pointer input. Esc closes the dialog, and
// the focus goes back to the Preview button, or the attachment list.

import { useEffect, useRef } from 'react';
import { IMAGE_FORMAT_NAMES } from '../shared/attachment-types';
import { BODY_IFRAME_REFERRER, BODY_IFRAME_SANDBOX } from '../shared/constants';
import { closePreview, saveAttachment, type ReaderPreview } from './reader';
import { fileSize } from './reader-format';
import './preview-dialog.css';

const ICON = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Puts the focus back where the preview came from, once the dialog has gone. */
function restoreFocus(index: number): void {
  // A timer, not an animation frame: a hidden window gets no frames.
  setTimeout(() => {
    const button = document.querySelector<HTMLElement>(`[data-preview-index="${index}"]`);
    const list = document.querySelector<HTMLElement>('.rp-att-list');
    (button ?? list)?.focus();
  }, 0);
}

export function PreviewDialog({ preview }: { preview: ReaderPreview }) {
  const index = useRef(preview.index);
  useEffect(() => {
    index.current = preview.index;
  }, [preview.index]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePreview();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreFocus(index.current);
    };
  }, []);
  const { image } = preview;
  return (
    <div
      className="pv-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) closePreview();
      }}
    >
      <div className="pv-dialog" role="dialog" aria-modal="true" aria-labelledby="pv-title">
        <div className="pv-head">
          <svg className="pv-icon" {...ICON} width={18} height={18} viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <h3 id="pv-title" dir="auto">
            {preview.name}
          </h3>
          <button type="button" className="pv-close" aria-label="Close" onClick={closePreview}>
            <svg className="pv-icon" {...ICON} width={16} height={16} viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="pv-body">
          <iframe
            className="pv-frame"
            title="Preview"
            src={preview.url}
            sandbox={BODY_IFRAME_SANDBOX}
            referrerPolicy={BODY_IFRAME_REFERRER}
            tabIndex={-1}
          />
          <p className="pv-line">
            {IMAGE_FORMAT_NAMES[image.format]} · {fileSize(preview.size)} · {image.width} ×{' '}
            {image.height}
          </p>
        </div>
        <div className="pv-foot">
          <button type="button" className="pv-btn pv-cancel" autoFocus onClick={closePreview}>
            Close
          </button>
          <button
            type="button"
            className="pv-btn pv-primary pv-save"
            onClick={() => void saveAttachment(preview.index)}
          >
            <svg className="pv-icon" {...ICON} width={14} height={14} viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
