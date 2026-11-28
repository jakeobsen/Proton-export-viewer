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
import { MESSAGE_VIEWS, THEMES, type AppSettings } from '../shared/settings';

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
    typeof p.mail === 'boolean' &&
    typeof p.unclear === 'boolean' &&
    (host === null ||
      (typeof host === 'object' && typeof host.start === 'number' && typeof host.end === 'number'))
  );
}

/** True for settings as main sends them. */
function isSettings(value: unknown): value is AppSettings {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    (THEMES as readonly unknown[]).includes(s.theme) &&
    (MESSAGE_VIEWS as readonly unknown[]).includes(s.messageView)
  );
}

const api: PevApi = {
  state: () => ipcRenderer.invoke(IPC.state),
  ping: (generation) => ipcRenderer.invoke(IPC.ping, { generation }),
  openStub: (id, generation) => ipcRenderer.invoke(IPC.openStub, { id, generation }),
  open: (rowid, mode, generation, queryId) =>
    ipcRenderer.invoke(
      IPC.open,
      queryId === undefined ? { rowid, mode, generation } : { rowid, mode, generation, queryId },
    ),
  closeView: (generation) => ipcRenderer.invoke(IPC.closeView, { generation }),
  showInFolder: (openId, generation) =>
    ipcRenderer.invoke(IPC.showInFolder, { openId, generation }),
  copyMessageId: (openId, generation) =>
    ipcRenderer.invoke(IPC.copyMessageId, { openId, generation }),
  viewSource: (openId, generation) => ipcRenderer.invoke(IPC.viewSource, { openId, generation }),
  sourceTree: (openId, generation) => ipcRenderer.invoke(IPC.sourceTree, { openId, generation }),
  sourcePart: (openId, path, generation) =>
    ipcRenderer.invoke(IPC.sourcePart, { openId, path, generation }),
  copyHeaders: (openId, generation) => ipcRenderer.invoke(IPC.copyHeaders, { openId, generation }),
  sourceBack: (openId, generation) => ipcRenderer.invoke(IPC.sourceBack, { openId, generation }),
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
  onCardKey: (listener) => {
    const handler = (_event: unknown, key: unknown) => {
      if (key === 'n' || key === 'p') listener(key);
    };
    ipcRenderer.on(IPC.cardKey, handler);
    return () => {
      ipcRenderer.off(IPC.cardKey, handler);
    };
  },
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
  cards: (query, generation) => ipcRenderer.invoke(IPC.index, { query, generation }),
  indexReport: (generation) =>
    ipcRenderer.invoke(IPC.index, { query: { op: 'report' }, generation }),
  copyReport: (generation) => ipcRenderer.invoke(IPC.copyReport, { generation }),
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
      chips: request.chips ?? [],
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
  leads: (request, generation) =>
    ipcRenderer.invoke(IPC.leads, {
      requester: request.requester,
      rowids: request.rowids,
      ...(request.queryId === undefined ? {} : { queryId: request.queryId }),
      generation,
    }),
  settings: (generation) => ipcRenderer.invoke(IPC.settings, { generation }),
  setSetting: (key, value, generation) =>
    ipcRenderer.invoke(IPC.setSetting, { key, value, generation }),
  onSettingsChanged: (listener) => {
    const handler = (_event: unknown, settings: unknown) => {
      if (isSettings(settings))
        listener({ theme: settings.theme, messageView: settings.messageView });
    };
    ipcRenderer.on(IPC.settingsChanged, handler);
    return () => {
      ipcRenderer.off(IPC.settingsChanged, handler);
    };
  },
  onShowSettings: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.showSettings, handler);
    return () => {
      ipcRenderer.off(IPC.showSettings, handler);
    };
  },
  onAppReset: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.appReset, handler);
    return () => {
      ipcRenderer.off(IPC.appReset, handler);
    };
  },
  rebuildIndex: (sourceKey, generation) =>
    ipcRenderer.invoke(IPC.rebuildIndex, { sourceKey, generation }),
  resetApp: (generation) => ipcRenderer.invoke(IPC.resetApp, { generation }),
  commitSearch: (queryId, generation) =>
    ipcRenderer.invoke(IPC.commitSearch, { queryId, generation }),
  recentSearches: (generation) => ipcRenderer.invoke(IPC.recentSearches, { generation }),
  setKeepRecent: (sourceKey, keep, generation) =>
    ipcRenderer.invoke(IPC.keepRecent, { sourceKey, keep, generation }),
  clearRecent: (sourceKey, generation) =>
    ipcRenderer.invoke(IPC.clearRecent, { sourceKey, generation }),
  openLogs: (generation) => ipcRenderer.invoke(IPC.openLogs, { generation }),
  copyDiagnostics: (generation) => ipcRenderer.invoke(IPC.copyDiagnostics, { generation }),
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
