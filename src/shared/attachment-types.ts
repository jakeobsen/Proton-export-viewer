// SPDX-License-Identifier: AGPL-3.0-or-later
// What the attachment list says about a file: a type label from a fixed map,
// never from mail data, and whether its extension marks a program. Images
// are labelled by the format their bytes have; everything else by its cleaned
// final extension.

import { extensionOf } from './filename';

/** A raster format found from an image's own bytes. */
export type RasterFormat = 'png' | 'jpeg' | 'gif' | 'webp';

const IMAGE_LABELS: Record<RasterFormat, string> = {
  png: 'PNG image',
  jpeg: 'JPEG image',
  gif: 'GIF image',
  webp: 'WebP image',
};

/** Extensions of Windows programs and scripts. */
const WINDOWS_PROGRAMS = [
  'exe',
  'msi',
  'bat',
  'cmd',
  'com',
  'scr',
  'pif',
  'cpl',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'ps1',
  'hta',
  'lnk',
  'reg',
];

/** Extensions of other programs, scripts and files that run or open something. */
const OTHER_PROGRAMS = [
  // Java
  'jar',
  // macOS
  'app',
  'pkg',
  'dmg',
  'command',
  'tool',
  'workflow',
  'terminal',
  'scpt',
  'applescript',
  'webloc',
  'inetloc',
  'fileloc',
  'mpkg',
  'prefpane',
  // Unix
  'sh',
  // Office files with macros
  'docm',
  'xlsm',
  'pptm',
  // Web and launch files
  'jnlp',
  'url',
  'html',
  'htm',
  'xhtml',
  'svg',
];

const WINDOWS = new Set(WINDOWS_PROGRAMS);
const RISKY = new Set([...WINDOWS_PROGRAMS, ...OTHER_PROGRAMS]);

const LABELS: Record<string, string> = {
  pdf: 'PDF document',
  txt: 'Text',
  ics: 'Calendar invite',
  zip: 'Archive',
  rar: 'Archive',
  '7z': 'Archive',
  tar: 'Archive',
  gz: 'Archive',
  tgz: 'Archive',
  bz2: 'Archive',
  xz: 'Archive',
};

/** A cleaned name's final extension, in lower case and without its dot. */
function extension(cleanName: string): string {
  return extensionOf(cleanName).slice(1).toLowerCase();
}

/** True when a cleaned name's final extension is one of a program or a script. */
export function isRisky(cleanName: string): boolean {
  return RISKY.has(extension(cleanName));
}

/**
 * The label the list shows for an attachment: from its detected raster format
 * if it is an image, otherwise from its cleaned final extension.
 */
export function typeLabel(cleanName: string, format: RasterFormat | null): string {
  if (format) return IMAGE_LABELS[format];
  const ext = extension(cleanName);
  if (WINDOWS.has(ext)) return 'Windows program';
  if (RISKY.has(ext)) return 'Program';
  return LABELS[ext] ?? 'File';
}
