// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings: the open export's index, the logs, and appearance. What it shows
// comes from main in one read; each action carries the generation of that
// read, and Rebuild and Forget the export it showed, so an action offered for
// one export can never act on another.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DoneResult, SettingsView, SourceActionResult } from '../shared/api';
import { byteSize } from '../shared/bytes';
import { filesText } from '../shared/report-text';
import type { MessageView, Theme } from '../shared/settings';
import { changedAt, fullTextStatus } from './format';
import { exportLabel } from './labels';
import { useMailbox } from './mailbox-state';
import { openReportFrom } from './Report';
import './settings.css';
import {
  changeSetting,
  forgetExport,
  getShellState,
  rebuildIndex,
  refreshGeneration,
  resetApp,
  showMail,
  useShellState,
} from './shell';

type Tab = 'index' | 'logs' | 'appearance';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'index', label: 'Index' },
  { id: 'logs', label: 'Logs' },
  { id: 'appearance', label: 'Appearance' },
];

const THEME_CHOICES: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const VIEW_CHOICES: ReadonlyArray<{ value: MessageView; label: string }> = [
  { value: 'html', label: 'HTML' },
  { value: 'plain', label: 'Plain text' },
];

/** What Settings says when an action didn't do what it offered; null when it did. */
function actionNotice(result: SourceActionResult | DoneResult): string | null {
  if (!result.ok) {
    if (result.code === 'refused') return "Not reset: an export is inside the app's data folder.";
    if (result.code === 'not_deleted') return "Some app files couldn't be deleted.";
    if (result.code === 'failed') return "Couldn't open the logs folder.";
    return 'Export changed. Try again.';
  }
  if (!('outcome' in result)) return null;
  if (result.outcome === 'busy') return 'Index in use. Try again.';
  if (result.outcome === 'offline' || result.outcome === 'unavailable') return 'Export not found.';
  if (result.outcome === 'closed') return 'Try again.';
  return null;
}

type Say = (result: SourceActionResult | DoneResult) => void;

/** How often Settings reads again while indexing reports progress. */
const PROGRESS_READ_MS = 1000;

interface Read {
  generation: number;
  view: SettingsView;
}

/** Settings as main shows it, read again whenever the generation, the exports or the settings change. */
function useSettingsRead(): Read | null {
  const shell = useShellState();
  const [read, setRead] = useState<Read | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      let generation = getShellState().generation ?? (await refreshGeneration());
      for (let attempt = 0; attempt < 2 && generation !== null && live; attempt += 1) {
        const result = await window.pev.settings(generation);
        if (!live) return;
        if (result.ok) {
          setRead({ generation: result.generation, view: result.view });
          return;
        }
        if (result.code !== 'stale_generation') return;
        generation = await refreshGeneration();
      }
    };
    void load();
    // The index's size and change time move while it is being built.
    const off = window.pev.onIndexChanged(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, PROGRESS_READ_MS);
    });
    return () => {
      live = false;
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [shell.generation, shell.sources, shell.settings]);
  return read;
}

/** The share of `text` kept when it's clipped: the start, and more of the end, where the file name is. */
function clipped(text: string, keep: number): string {
  if (keep >= text.length) return text;
  const head = Math.floor(keep * 0.3);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

let measureCanvas: HTMLCanvasElement | null = null;

/**
 * A long path on one line, clipped in the middle with "…" when it doesn't
 * fit. The full value shows on hover, and in place while it has focus.
 */
function MiddleClip({ text }: { text: string }) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(text);
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || focused) return;
    measureCanvas ??= document.createElement('canvas');
    const context = measureCanvas.getContext('2d');
    if (!context) return;
    const fit = () => {
      context.font = getComputedStyle(el).font;
      const width = el.clientWidth;
      const fits = (s: string) => context.measureText(s).width <= width;
      if (width <= 0 || fits(text)) {
        setShown(text);
        return;
      }
      let low = 0;
      let high = text.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(clipped(text, mid))) low = mid;
        else high = mid - 1;
      }
      setShown(clipped(text, low));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, focused]);
  return (
    <dd
      ref={ref}
      className={`mono middle-clip${focused ? ' full' : ''}`}
      title={text}
      aria-label={text}
      tabIndex={0}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {focused ? text : shown}
    </dd>
  );
}

function ResetDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  // Focus stays in the dialog while it's open.
  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialog.current) return;
    const buttons = [...dialog.current.querySelectorAll<HTMLButtonElement>('button')];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
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
      className="settings-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialog}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-title"
        onKeyDown={trap}
      >
        <h3 id="reset-title">Reset app?</h3>
        <p>Deletes all app data. Export files stay intact.</p>
        <div className="row-actions">
          <button type="button" className="btn" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={onConfirm}>
            Reset app
          </button>
        </div>
      </div>
    </div>
  );
}

function IndexTab({ read, busy, say }: { read: Read; busy: boolean; say: Say }) {
  const [forgetting, setForgetting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const index = read.view.index;
  const { generation } = read;
  const { progress, report } = useMailbox();
  return (
    <section className="tabpanel" id="settings-index" role="tabpanel" aria-label="Index">
      <h2>Index</h2>
      {index !== null && (
        <div className="sec">
          <h3>
            {index.account !== null
              ? `${index.account} · ${exportLabel(index.runName)}`
              : exportLabel(index.runName)}
          </h3>
          <dl className="kv">
            <dt>Location</dt>
            <MiddleClip text={index.location} />
            <dt>Size</dt>
            <dd>{byteSize(index.bytes)}</dd>
            <dt>Last updated</dt>
            <dd>{index.updatedAt === null ? '' : changedAt(index.updatedAt)}</dd>
            {progress !== null && (
              <>
                <dt>Status</dt>
                <dd className="status">{fullTextStatus(progress)}</dd>
              </>
            )}
            {report !== null && (
              <>
                <dt>Files</dt>
                <dd className="files">
                  {filesText(report)} ·{' '}
                  <button
                    type="button"
                    className="link"
                    onClick={(e) => {
                      // The report shows over the mail, in Settings' place.
                      showMail();
                      openReportFrom(e.currentTarget);
                    }}
                  >
                    Report
                  </button>
                </dd>
              </>
            )}
          </dl>
          <div className="row-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void rebuildIndex(index.sourceKey, generation).then(say)}
            >
              Rebuild index
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              aria-expanded={forgetting}
              onClick={() => setForgetting((v) => !v)}
            >
              Forget this export…
            </button>
          </div>
          {forgetting && (
            <div className="confirm-box" role="group" aria-label="Forget this export">
              <p>
                Removes this export from the app and deletes its index. Export files stay intact.
              </p>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => setForgetting(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn danger"
                  disabled={busy}
                  onClick={() => {
                    setForgetting(false);
                    void forgetExport(index.sourceKey, generation).then((result) => {
                      if (result.ok && result.outcome === 'forgotten') showMail();
                      else say(result);
                    });
                  }}
                >
                  Forget this export
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="sec">
        <div className="row-actions first">
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => setResetting(true)}
          >
            Reset app…
          </button>
        </div>
      </div>
      {resetting && (
        <ResetDialog
          onCancel={() => setResetting(false)}
          onConfirm={() => {
            setResetting(false);
            void resetApp(generation).then(say);
          }}
        />
      )}
    </section>
  );
}

function LogsTab({ read, say }: { read: Read; say: Say }) {
  return (
    <section className="tabpanel" id="settings-logs" role="tabpanel" aria-label="Logs">
      <h2>Logs</h2>
      <div className="sec">
        <h3>Log files</h3>
        <dl className="kv">
          <dt>Location</dt>
          <MiddleClip text={read.view.logsLocation} />
        </dl>
        <div className="row-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void window.pev.openLogs(read.generation).then(say)}
          >
            Open logs folder
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void window.pev.copyDiagnostics(read.generation).then(say)}
          >
            Copy diagnostics summary
          </button>
        </div>
      </div>
    </section>
  );
}

function Choices<T extends string>({
  name,
  label,
  choices,
  value,
  onChange,
}: {
  name: string;
  label: string;
  choices: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="radio-row" role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <label key={choice.value}>
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={value === choice.value}
            onChange={() => onChange(choice.value)}
          />
          {choice.label}
        </label>
      ))}
    </div>
  );
}

function AppearanceTab() {
  const { settings } = useShellState();
  return (
    <section className="tabpanel" id="settings-appearance" role="tabpanel" aria-label="Appearance">
      <h2>Appearance</h2>
      <div className="sec">
        <h3>Theme</h3>
        <Choices
          name="theme"
          label="Theme"
          choices={THEME_CHOICES}
          value={settings.theme}
          onChange={(theme) => void changeSetting('theme', theme)}
        />
      </div>
      <div className="sec">
        <h3>Default message view</h3>
        <Choices
          name="message-view"
          label="Default message view"
          choices={VIEW_CHOICES}
          value={settings.messageView}
          onChange={(view) => void changeSetting('messageView', view)}
        />
      </div>
    </section>
  );
}

export function Settings() {
  const { busy } = useShellState();
  const read = useSettingsRead();
  const [tab, setTab] = useState<Tab>('index');
  const [notice, setNotice] = useState<string | null>(null);
  const say: Say = (result) => setNotice(actionNotice(result));
  return (
    <main className="settings" aria-label="Settings">
      <nav className="tabs" role="tablist" aria-label="Settings">
        <button type="button" className="btn ghost back" onClick={showMail}>
          Back to mail
        </button>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="tab"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`settings-${t.id}`}
            onClick={() => {
              setTab(t.id);
              setNotice(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="tabpanels">
        {notice !== null && (
          <p className="settings-notice" role="status">
            {notice}
          </p>
        )}
        {read !== null && tab === 'index' && (
          // Keyed by the export and generation it was read under: a
          // confirmation offered for one never carries over to another.
          <IndexTab
            key={`${read.view.index?.sourceKey ?? ''}:${read.generation}`}
            read={read}
            busy={busy}
            say={say}
          />
        )}
        {read !== null && tab === 'logs' && <LogsTab read={read} say={say} />}
        {tab === 'appearance' && <AppearanceTab />}
      </div>
    </main>
  );
}
