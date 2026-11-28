// SPDX-License-Identifier: AGPL-3.0-or-later
// Folder and label chips. A name is export data: shown as text, isolated
// from the text around it so a direction mark in it can't reorder the row,
// and cut with an ellipsis when it is too long.

import { labelChips } from './chips-model';
import type { SidebarEntry, SidebarModel } from './folders';

const FOLDER_ICON = {
  width: 11,
  height: 11,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** A chip's name; `full` adds the whole name on hover. */
function ChipName({ name, full = false }: { name: string; full?: boolean }) {
  return (
    <span className="chip-name" dir="auto" title={full ? name : undefined}>
      {name}
    </span>
  );
}

/** A label: its colour dot and name. */
export function LabelChip({
  label,
  focusable = false,
}: {
  label: SidebarEntry;
  focusable?: boolean;
}) {
  return (
    <span className="chip" data-label={label.id} tabIndex={focusable ? 0 : undefined}>
      <span
        className={label.color ? 'dot' : 'dot plain'}
        style={label.color ? { background: label.color } : undefined}
        aria-hidden="true"
      />
      <ChipName name={label.name} full={focusable} />
    </span>
  );
}

/** A folder: the folder icon and its name. */
export function FolderChip({ folder }: { folder: SidebarEntry }) {
  return (
    <span className="chip folder" data-folder={folder.id} tabIndex={0}>
      <svg className="chip-icon" {...FOLDER_ICON}>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <ChipName name={folder.name} full />
    </span>
  );
}

/** A conversation's labels in its list row, as chips. */
export function Chips({
  labelIds,
  sidebar,
}: {
  labelIds: readonly string[] | undefined;
  sidebar: SidebarModel | null;
}) {
  const labels = labelChips(labelIds, sidebar);
  if (labels.length === 0) return null;
  return (
    <div className="chips">
      {labels.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
    </div>
  );
}
