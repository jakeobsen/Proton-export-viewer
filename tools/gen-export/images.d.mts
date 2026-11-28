// SPDX-License-Identifier: AGPL-3.0-or-later
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function pngChunk(type: string, data: Buffer): Buffer;
export function storedZlib(data: Buffer): Buffer;
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer;
export function dimensionBombPng(width: number, height: number): Buffer;
export function paddedPng(bytes: number): Buffer;
export function apng(
  width: number,
  height: number,
  frames: number,
  options?: { declared?: number; rect?: Rect; separateDefault?: boolean },
): Buffer;
export function gifImage(
  width: number,
  height: number,
  frames: number,
  options?: { rgb?: [number, number, number]; full?: boolean; rect?: Rect },
): Buffer;
export function gif(width: number, height: number, frames: number): Buffer;
export function webpImage(width: number, height: number, options?: { lossy?: boolean }): Buffer;
export function webpAnimated(
  width: number,
  height: number,
  frames: number,
  options?: { rect?: Rect; bitstream?: { width: number; height: number }; still?: boolean },
): Buffer;
export function jpegImage(width: number, height: number, options?: { scans?: number }): Buffer;
