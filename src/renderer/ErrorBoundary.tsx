// SPDX-License-Identifier: AGPL-3.0-or-later
// Catches a throw while the shell renders. Without it the whole window would
// go empty; with it the window keeps its bar and says so, offers Reopen, and
// the error is reported like any uncaught one: class and app frames only.

import { Component, type ReactNode } from 'react';
import { reportError } from './errors';
import { getShellState, openExport, refreshSources } from './shell';

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    reportError('uncaught', error);
  }

  /** Opens the open export again, under a new generation, so every view starts afresh. */
  private readonly reopen = async (): Promise<void> => {
    const key = getShellState().sources?.active?.sourceKey;
    try {
      if (key) await openExport(key);
      else await refreshSources();
    } finally {
      this.setState({ failed: false });
    }
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="shell">
        <header className="bar">
          <span className="bar-title">{__PEV_APP_NAME__}</span>
        </header>
        <div className="banner" role="alert">
          <span>Stopped after an error.</span>
          <button type="button" className="btn" onClick={() => void this.reopen()}>
            Reopen
          </button>
        </div>
      </div>
    );
  }
}
