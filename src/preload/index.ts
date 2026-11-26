// SPDX-License-Identifier: AGPL-3.0-or-later
// Preload for the shell's main frame. It exposes a small typed API and nothing else.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ErrorReport, type PevApi } from '../shared/api';

const api: PevApi = {
  state: () => ipcRenderer.invoke(IPC.state),
  ping: (generation) => ipcRenderer.invoke(IPC.ping, { generation }),
  openStub: (id, generation) => ipcRenderer.invoke(IPC.openStub, { id, generation }),
  open: (rowid, mode, generation) => ipcRenderer.invoke(IPC.open, { rowid, mode, generation }),
  log: (level, code, generation, data) =>
    ipcRenderer.send(
      IPC.log,
      data ? { generation, level, code, data } : { generation, level, code },
    ),
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
  sources: (generation) => ipcRenderer.invoke(IPC.sources, { generation }),
  chooseFolder: (generation) => ipcRenderer.invoke(IPC.chooseFolder, { generation }),
  openExport: (sourceKey, generation) =>
    ipcRenderer.invoke(IPC.openExport, { sourceKey, generation }),
  switchRun: (runId, generation) => ipcRenderer.invoke(IPC.switchRun, { runId, generation }),
  locateExport: (generation) => ipcRenderer.invoke(IPC.locateExport, { generation }),
  onSourcesChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.sourcesChanged, handler);
    return () => {
      ipcRenderer.off(IPC.sourcesChanged, handler);
    };
  },
};

contextBridge.exposeInMainWorld('pev', api);

if (__PEV_TEST_HOOKS__) {
  // Builds with test hooks only: raw access to the app's channels, so tests can
  // send malformed requests and check that the main process rejects them itself.
  const channels: readonly string[] = Object.values(IPC);
  const known = (channel: unknown): channel is string =>
    typeof channel === 'string' && channels.includes(channel);
  contextBridge.exposeInMainWorld('__pevTestIpc', {
    invoke: (channel: unknown, ...args: unknown[]) =>
      known(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('channel')),
    send: (channel: unknown, ...args: unknown[]) => {
      if (known(channel)) ipcRenderer.send(channel, ...args);
    },
  });
}
