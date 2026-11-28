// SPDX-License-Identifier: AGPL-3.0-or-later

import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { installErrorHandlers } from './errors';
import { refreshGeneration } from './shell';

installErrorHandlers();

if (__PEV_TEST_HOOKS__) {
  void import('../testhooks/renderer').then((hooks) => hooks.install());
}

void refreshGeneration();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
