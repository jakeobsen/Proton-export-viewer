// SPDX-License-Identifier: AGPL-3.0-or-later
// Preload for the shell's main frame. It exposes a small typed API and nothing else.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ErrorReport, type PevApi } from '../shared/api';

const api: PevApi = {
  state: () => ipcRenderer.invoke(IPC.state),
  ping: (generation) => ipcRenderer.invoke(IPC.ping, { generation }),
  openStub: (id, generation) => ipcRenderer.invoke(IPC.openStub, { id, generation }),
  log: (level, code, data) =>
    ipcRenderer.send(IPC.log, data ? { level, code, data } : { level, code }),
  reportError: (report: ErrorReport) => ipcRenderer.send(IPC.report, report),
  onLinkDialog: (listener) => {
    const handler = (_event: unknown, url: unknown) => {
      if (typeof url === 'string') listener(url);
    };
    ipcRenderer.on(IPC.linkDialog, handler);
    return () => {
      ipcRenderer.off(IPC.linkDialog, handler);
    };
  },
};

contextBridge.exposeInMainWorld('pev', api);
