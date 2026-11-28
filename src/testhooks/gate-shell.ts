// SPDX-License-Identifier: AGPL-3.0-or-later
// The gate mode's shell side, reached as window.__pevTest.gate: it times
// animation frames after DOM changes, records the cadence of frames with
// nothing changing, notes the first list rows, scrolls an element one step
// per frame, and times card expansions to the body frame's load. Every wait
// has a time limit, so a frame that never comes ends a step instead of
// hanging it.

import { cards } from '../renderer/mailbox-state';
import { markLoaded } from './marker';
import { waitSince } from './open-pace';
import { stepStamp } from './gate-step';
import type {
  ExpansionItem,
  FirstRows,
  FrameRun,
  RafProbe,
  ScrollRun,
  TimedExpansion,
} from './gate-types';

markLoaded();

/** A drawn list row: not a placeholder for a row still being read. */
export const LIST_ROW = '.list-scroll .conv:not(.placeholder)';
const BODY_FRAME = 'iframe.rp-frame';

/** The time of the next animation frame, or null if none came within `timeoutMs`. */
function nextFrame(timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, timeoutMs);
    requestAnimationFrame(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(performance.now());
    });
  });
}

/**
 * The next animation frame's own timestamp (the frame's start), or null if
 * none came within `timeoutMs`.
 */
function nextStamp(timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, timeoutMs);
    requestAnimationFrame((stamp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(stamp);
    });
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The timestamps of `count` consecutive frames, with nothing changing in the DOM. */
async function frameRun(count: number, timeoutMs: number): Promise<FrameRun> {
  const stamps: number[] = [];
  let timeouts = 0;
  for (let i = 0; i < count; i += 1) {
    const stamp = await nextStamp(timeoutMs);
    if (stamp === null) timeouts += 1;
    else stamps.push(stamp);
  }
  return { stamps, timeouts, timeoutMs };
}

/** Times `count` DOM changes, each to the animation frame after it. */
async function rafProbe(count: number, timeoutMs: number): Promise<RafProbe> {
  const marker = document.createElement('div');
  marker.setAttribute('aria-hidden', 'true');
  marker.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden';
  document.body.append(marker);
  const samples: number[] = [];
  let timeouts = 0;
  try {
    for (let i = 0; i < count; i += 1) {
      marker.textContent = String(i);
      const changed = performance.now();
      const frame = await nextFrame(timeoutMs);
      if (frame === null) timeouts += 1;
      else samples.push(frame - changed);
      // The next change starts outside the frame's callback.
      await tick();
    }
  } finally {
    marker.remove();
  }
  return { samples, timeouts, timeoutMs };
}

let rowsWatch: { result: FirstRows; observer: MutationObserver } | null = null;

/**
 * Watches for the first drawn list row from now on: notes when it is in the
 * DOM, then waits for the animation frame after it, up to `frameMs`.
 */
function watchRows(frameMs: number): boolean {
  rowsWatch?.observer.disconnect();
  const result: FirstRows = { commitAt: null, rafAt: null, settled: false, rows: 0 };
  const present = document.querySelectorAll(LIST_ROW).length > 0;
  const observer = new MutationObserver(() => {
    if (result.commitAt !== null) return;
    const rows = document.querySelectorAll(LIST_ROW).length;
    if (rows === 0) return;
    result.commitAt = performance.now();
    result.rows = rows;
    observer.disconnect();
    void nextFrame(frameMs).then((at) => {
      result.rafAt = at;
      result.settled = true;
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  rowsWatch = { result, observer };
  // Rows already drawn would make the first change after now a later one.
  return !present;
}

function firstRows(): FirstRows | null {
  return rowsWatch ? { ...rowsWatch.result } : null;
}

/**
 * Scrolls the element `steps` times, one step (a quarter of its height) per
 * animation frame, turning at either end, and keeps each step's frame
 * timestamp. A frame that comes late still makes its step. A step whose frame
 * hasn't come within `waitMs`, nor in `graceMs` after that, ends the scroll.
 */
async function scroll(
  selector: string,
  steps: number,
  waitMs: number,
  graceMs: number,
): Promise<ScrollRun> {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`nothing to scroll: ${selector}`);
  const start = performance.now();
  const stamps: number[] = [];
  let stopped = false;
  let direction = 1;
  let range = 0;
  for (let i = 0; i < steps; i += 1) {
    const stamp = await stepStamp(nextStamp, waitMs, graceMs);
    if (stamp === null) {
      stopped = true;
      break;
    }
    stamps.push(stamp);
    range = Math.max(0, el.scrollHeight - el.clientHeight);
    const step = Math.max(1, Math.round(el.clientHeight / 4));
    let top = el.scrollTop + direction * step;
    if (top >= range) {
      top = range;
      direction = -1;
    } else if (top <= 0) {
      top = 0;
      direction = 1;
    }
    el.scrollTop = top;
  }
  return {
    selector,
    steps,
    stamps,
    stopped,
    waitMs: waitMs + graceMs,
    ms: performance.now() - start,
    range,
  };
}

/**
 * Resolves with the time the next body frame the shell adds has loaded, or
 * null if none loaded within `timeoutMs`. A view has a frame of its own, so
 * the frame is new for each view.
 */
function nextBodyLoad(timeoutMs: number): { loaded: Promise<number | null>; cancel: () => void } {
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const before = new Set(document.querySelectorAll(BODY_FRAME));
  let finish: (at: number | null) => void = () => undefined;
  const loaded = new Promise<number | null>((resolve) => {
    let done = false;
    finish = (at) => {
      if (done) return;
      done = true;
      observer?.disconnect();
      if (timer !== null) clearTimeout(timer);
      resolve(at);
    };
    const attach = () => {
      for (const f of document.querySelectorAll<HTMLIFrameElement>(BODY_FRAME)) {
        if (before.has(f)) continue;
        before.add(f);
        f.addEventListener('load', () => finish(performance.now()), { once: true });
      }
    };
    observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    timer = setTimeout(() => finish(null), timeoutMs);
  });
  return { loaded, cancel: () => finish(null) };
}

async function until<T>(get: () => T | null, timeoutMs: number): Promise<T | null> {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value !== null) return value;
    if (performance.now() > end) return null;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Shows the message's conversation at its newest message and waits for that
 * body (untimed), has the cards model read the card, then times the expand
 * from just before the call to the new body frame's load. The expand starts
 * at least OPEN_PACE_MS after the shown body loaded: main let that open
 * through before the body could load, so main's open pacer never holds the
 * timed one.
 */
async function expandOne(item: ExpansionItem, stepMs: number): Promise<TimedExpansion> {
  const { rowid } = item;
  const shown = nextBodyLoad(stepMs);
  cards.show(item.newest, item.threadId);
  const shownAt = await shown.loaded;
  if (shownAt === null) return { rowid, ms: null, gapMs: null, outcome: 'timeout' };
  cards.setViewport(item.index, item.index);
  const card = await until(() => {
    const c = cards.cardAt(item.index);
    return c !== null && c.rowid === item.rowid ? c : null;
  }, stepMs);
  if (card === null) return { rowid, ms: null, gapMs: null, outcome: 'not-held' };
  await waitSince(shownAt);
  const next = nextBodyLoad(stepMs);
  const start = performance.now();
  const gapMs = start - shownAt;
  if (!cards.expand(card)) {
    next.cancel();
    return { rowid, ms: null, gapMs, outcome: 'not-expanded' };
  }
  const end = await next.loaded;
  return end === null
    ? { rowid, ms: null, gapMs, outcome: 'timeout' }
    : { rowid, ms: end - start, gapMs, outcome: 'view' };
}

/** Expands each message in turn: the first `warmup` untimed, then every one timed. */
async function expandTimes(
  items: ExpansionItem[],
  warmup: number,
  stepMs: number,
): Promise<{ warm: TimedExpansion[]; timed: TimedExpansion[] }> {
  const warm: TimedExpansion[] = [];
  for (const item of items.slice(0, warmup)) warm.push(await expandOne(item, stepMs));
  const timed: TimedExpansion[] = [];
  for (const item of items) timed.push(await expandOne(item, stepMs));
  return { warm, timed };
}

export const gateShell = {
  timeOrigin: () => performance.timeOrigin,
  now: () => performance.now(),
  rafProbe,
  frameRun,
  watchRows,
  firstRows,
  scroll,
  expandTimes,
  /** Shows a conversation at its newest message, for a scroll of its cards. */
  showConversation: (newest: number, threadId: number) => cards.show(newest, threadId),
  hideConversation: () => cards.hide(),
};
