// SPDX-License-Identifier: AGPL-3.0-or-later
// labels.json: the account's folders and labels. System folders are known by
// their ID, because their Type isn't consistent. For the others, Type 3 is a
// folder and Type 1 a label; nesting comes from ParentID or, failing that,
// from the "/"-separated Path. A color is kept only if it is "#" and six hex
// digits.

export const SYSTEM_LABELS = {
  inbox: '0',
  allDrafts: '1',
  allSent: '2',
  trash: '3',
  spam: '4',
  allMail: '5',
  archive: '6',
  sent: '7',
  drafts: '8',
  outbox: '9',
  starred: '10',
  allScheduled: '12',
  /** A second "All Mail"; never shown. */
  allMailCopy: '15',
  snoozed: '16',
} as const;

const SYSTEM_IDS: ReadonlySet<string> = new Set(Object.values(SYSTEM_LABELS));

export function isSystemLabel(id: string): boolean {
  return SYSTEM_IDS.has(id);
}

/** 'other' entries (an unknown Type) are stored but not shown. */
export type LabelKind = 'system' | 'folder' | 'label' | 'other';

export interface LabelEntry {
  id: string;
  name: string;
  path: string;
  /** The parent folder or label, when it exists in the file; null at the top. */
  parentId: string | null;
  color: string | null;
  type: number;
  kind: LabelKind;
}

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const MAX_ID_LENGTH = 256;
const MAX_TEXT = 1024;
/** labels.json entries beyond this many are ignored. */
export const MAX_LABEL_ENTRIES = 20_000;

export class LabelsError extends Error {
  constructor(readonly code: 'LABELS_JSON' | 'LABELS_SHAPE') {
    super(code);
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');

function kindOf(id: string, type: number): LabelKind {
  if (isSystemLabel(id)) return 'system';
  if (type === 3) return 'folder';
  if (type === 1) return 'label';
  return 'other';
}

/** Parses labels.json. Entries without a usable ID are skipped; a repeated ID keeps its first entry. */
export function parseLabels(raw: string): LabelEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new LabelsError('LABELS_JSON');
  }
  const payload = (doc as { Payload?: unknown } | null)?.Payload;
  if (!Array.isArray(payload)) throw new LabelsError('LABELS_SHAPE');
  const byId = new Map<string, LabelEntry & { rawParent: string }>();
  for (const item of payload.slice(0, MAX_LABEL_ENTRIES)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.ID === 'string' ? o.ID : '';
    if (id.length === 0 || id.length > MAX_ID_LENGTH || byId.has(id)) continue;
    const type = typeof o.Type === 'number' && Number.isInteger(o.Type) ? o.Type : 0;
    const path = text(o.Path);
    const name = text(o.Name) || path.split('/').pop() || '';
    const color = typeof o.Color === 'string' && COLOR.test(o.Color) ? o.Color : null;
    byId.set(id, {
      id,
      name,
      path,
      parentId: null,
      color,
      type,
      kind: kindOf(id, type),
      rawParent: text(o.ParentID),
    });
  }
  resolveParents(byId);
  return [...byId.values()].map((e) => ({
    id: e.id,
    name: e.name,
    path: e.path,
    parentId: e.parentId,
    color: e.color,
    type: e.type,
    kind: e.kind,
  }));
}

/**
 * Sets each user folder's or label's parent: its ParentID if that names an
 * entry of the same kind, else the entry whose Path is its Path without the
 * last segment. A parent that would make a cycle is dropped.
 */
function resolveParents(byId: Map<string, LabelEntry & { rawParent: string }>): void {
  const byPath = new Map<string, string>();
  for (const e of byId.values()) {
    if ((e.kind === 'folder' || e.kind === 'label') && e.path && !byPath.has(`${e.kind}:${e.path}`))
      byPath.set(`${e.kind}:${e.path}`, e.id);
  }
  for (const e of byId.values()) {
    if (e.kind !== 'folder' && e.kind !== 'label') continue;
    const parent = byId.get(e.rawParent);
    if (parent && parent.id !== e.id && parent.kind === e.kind) {
      e.parentId = parent.id;
      continue;
    }
    const cut = e.path.lastIndexOf('/');
    if (cut > 0) {
      const up = byPath.get(`${e.kind}:${e.path.slice(0, cut)}`);
      if (up && up !== e.id) e.parentId = up;
    }
  }
  // Walk up from each entry; a chain that comes back to itself loses its last link.
  for (const e of byId.values()) {
    const seen = new Set<string>([e.id]);
    let at: (LabelEntry & { rawParent: string }) | undefined = e;
    while (at?.parentId) {
      if (seen.has(at.parentId)) {
        at.parentId = null;
        break;
      }
      seen.add(at.parentId);
      at = byId.get(at.parentId);
    }
  }
}
