/* eslint-disable import/first */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { enableMapSet } from 'immer';
import '@fontsource/inter/variable.css';
import 'folds/dist/style.css';
import { configClass, varsClass } from 'folds';

enableMapSet();

import './index.scss';

import settings from './client/state/settings';

import { trimTrailingSlash } from './app/utils/common';
import App from './app/pages/App';

// import i18n (needs to be bundled ;))
import './app/i18n';
import { PeerjsFrontendManager } from './matrix-shim/peerjsFrontend';

document.body.classList.add(configClass, varsClass);
settings.applyTheme();

const rootContainer = document.getElementById('root');
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const root = createRoot(rootContainer!);

const renderApp = () => {
  root.render(<App />);
};

const renderError = (error: string) => {
  root.render(
    <div>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '1em' }}>
        <div style={{ color: 'white', fontSize: '40px' }}>
          <span style={{ color: 'red' }}>Error loading app:&nbsp;</span>
          {error}
        </div>
      </div>
    </div>
  );
};

(globalThis as any).peerManager = new PeerjsFrontendManager();

// Register Service Worker
if ('serviceWorker' in navigator) {
  const serviceWorkerReady = new BroadcastChannel('service-worker-ready');
  serviceWorkerReady.postMessage({ checkReady: true });

  const swUrl =
    import.meta.env.MODE === 'production'
      ? `${trimTrailingSlash(import.meta.env.BASE_URL)}/sw.js`
      : `/dev-sw.js?dev-sw`;

  navigator.serviceWorker.register(swUrl, { type: import.meta.env.DEV ? 'module' : 'classic' });
  navigator.serviceWorker.ready.then(() => {
    // This will reload the page if the controller value is null after hard-reload
    // So service worker will be registered correctly
    if (window.navigator.serviceWorker.controller === null) {
      window.location.reload();
    }
  });

  serviceWorkerReady.addEventListener('message', (ev) => {
    console.log('Service Worker:', ev.data);
    // If the service worker is ready, render the app
    if ('ready' in ev.data) {
      renderApp();

      // If we get an error in the service worker
    } else if ('error' in ev.data) {
      // If we don't have any service worker at all
      if (!navigator.serviceWorker.controller) {
        // Render an error
        renderError(ev.data.error);

        // If we do have a currently-working service worker, and we are in prod
      } else if (import.meta.env.PROD) {
        // Log the error, but allow the client to continue using the working service worker.
        console.error(
          'Error: could not install updated service worker! App may be out-of-date.',
          ev.data.error
        );

        // If we have an error in dev
      } else {
        // Render the error immediately so it doesn't go unnoticed.
        renderError(ev.data.error);
      }
    }
  });
} else {
  renderError('Service worker not supported in this browser.');
}
