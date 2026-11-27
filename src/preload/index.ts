// SPDX-License-Identifier: AGPL-3.0-or-later
// Preload for the shell's main frame. It exposes a small typed API and nothing else.

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type ErrorReport,
  type IndexUpdate,
  type LinkPrompt,
  type PevApi,
} from '../shared/api';

/** True for a link prompt as main sends it. */
function isPrompt(value: unknown): value is LinkPrompt {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  const host = p.host as Record<string, unknown> | null;
  return (
    typeof p.dialogId === 'string' &&
    typeof p.title === 'string' &&
    typeof p.url === 'string' &&
    typeof p.mismatch === 'boolean' &&
    typeof p.lookalike === 'boolean' &&
    (host === null ||
      (typeof host === 'object' && typeof host.start === 'number' && typeof host.end === 'number'))
  );
}

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
    const handler = (_event: unknown, prompt: unknown) => {
      if (isPrompt(prompt)) listener(prompt);
    };
    ipcRenderer.on(IPC.linkDialog, handler);
    return () => {
      ipcRenderer.off(IPC.linkDialog, handler);
    };
  },
  linkAction: (dialogId, action, generation) =>
    ipcRenderer.invoke(IPC.linkAction, { dialogId, action, generation }),
  sources: (generation) => ipcRenderer.invoke(IPC.sources, { generation }),
  chooseFolder: (generation) => ipcRenderer.invoke(IPC.chooseFolder, { generation }),
  openExport: (sourceKey, generation) =>
    ipcRenderer.invoke(IPC.openExport, { sourceKey, generation }),
  switchRun: (runId, generation) => ipcRenderer.invoke(IPC.switchRun, { runId, generation }),
  locateExport: (generation) => ipcRenderer.invoke(IPC.locateExport, { generation }),
  forgetExport: (sourceKey, generation) =>
    ipcRenderer.invoke(IPC.forgetExport, { sourceKey, generation }),
  onSourcesChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.sourcesChanged, handler);
    return () => {
      ipcRenderer.off(IPC.sourcesChanged, handler);
    };
  },
  sidebar: (generation) => ipcRenderer.invoke(IPC.index, { query: { op: 'sidebar' }, generation }),
  listWindow: (query, generation) => ipcRenderer.invoke(IPC.index, { query, generation }),
  onIndexChanged: (listener) => {
    const handler = (_event: unknown, update: IndexUpdate) => listener(update);
    ipcRenderer.on(IPC.indexChanged, handler);
    return () => {
      ipcRenderer.off(IPC.indexChanged, handler);
    };
  },
  search: (request, generation) =>
    ipcRenderer.invoke(IPC.search, {
      text: request.text,
      sort: request.sort,
      after: request.after,
      generation,
    }),
  searchSnippets: (request, generation) =>
    ipcRenderer.invoke(IPC.searchSnippets, {
      queryId: request.queryId,
      threadIds: request.threadIds,
      generation,
    }),
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
