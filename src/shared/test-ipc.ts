// SPDX-License-Identifier: AGPL-3.0-or-later
// IPC channels that exist only in builds with test hooks. Nothing outside a
// `__PEV_TEST_HOOKS__` branch may use them, so release builds leave them out.

export const TEST_IPC = {
  /** Opens one of the test hooks' fixed placeholder bodies. */
  openStub: 'pev:open-stub',
} as const;
