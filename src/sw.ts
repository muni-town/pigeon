/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference lib="WebWorker" />

import { kvsIndexedDB } from '@kvs/indexeddb';
import { MatrixShim } from './matrix-shim';

export type {};
declare const self: ServiceWorkerGlobalScope;

// TODO: This might be a horrible local storage shim. I don't know how it handles multiple tabs
// open.
// Works for now... 🤞 We just need it so that the atproto/oauth-client-browser doesn't panic because
// localStorage isn't defined.
(globalThis as any).localStorageShimStore = kvsIndexedDB<{ data: string }>({
  name: 'localStorage-shim',
  version: 1,
});
globalThis.localStorage = {
  data: {} as { [key: string]: string },
  persist() {
    (globalThis as any).localStorageShimStore.then((s: any) => {
      s.set('data', JSON.stringify(this.data));
    });
  },
  clear() {
    this.data = {};
  },
  getItem(s: string): string | null {
    return this.data[s] || null;
  },
  key(idx: number): string | null {
    return (Object.values(this.data)[idx] as string | undefined) || null;
  },
  get length(): number {
    return Object.values(this.data).length;
  },
  removeItem(key: string) {
    this.data[key] = undefined;
    this.persist();
  },
  setItem(key: string, value: string) {
    this.data[key] = value;
    this.persist();
  },
};
(globalThis as any).localStorageShimStore.then(async (s: any) => {
  globalThis.localStorage.data = JSON.parse((await s.get('data')) || '{}');
});

/** Create a channel that is used to communicate our readiness to the application. */
const channel = new BroadcastChannel('service-worker-ready');

/** The matrix shim after it has been loaded. */
let matrixShim: MatrixShim | undefined;
/** An error string if the matrix shim initialization failed */
let matrixShimInitError: string | undefined;

// When the app asks for our status, send a response
channel.onmessage = (ev) => {
  if ('checkReady' in ev.data) {
    if (matrixShim) {
      channel.postMessage({ ready: true });
    } else if (matrixShimInitError) {
      channel.postMessage({ error: matrixShimInitError });
    } else {
      channel.postMessage({ loading: true });
    }
  }
};

let initializing: Promise<void> | undefined;
const tryInitMatrix = async () => {
  if (!initializing) {
    initializing = (async () => {
      try {
        // Start initializing the matrix shim.
        console.info('Matrix: initializing...');
        const shim = await MatrixShim.init();
        console.info('Matrix: initialized');
        matrixShim = shim;
        channel.postMessage({ ready: true });
      } catch (e) {
        console.info('Matrix: error initializing');
        matrixShimInitError = `${e}`;
        channel.postMessage({ error: e });
        throw e;
      }
    })();
  }
  await initializing;
};

// Immediately activate new service workers.
self.addEventListener('install', async () => {
  console.info('Service Worker: installing...');

  // Don't wait to install this service worker.
  self.skipWaiting();

  console.info('Service Worker: installed');

  // TODO: we may still end up waiting to update if we are currently in the middle of
  // responding to a request in the old service worker. We need to add an abort controller
  // so that we can kill all active requests.
});

// Immediately force all active clients to switch to the new service worker.
self.addEventListener('activate', async (event) => {
  console.info('Service Worker: activating...');

  // Wait until we are certain we are receiving all client fetches.
  event.waitUntil(self.clients.claim());

  tryInitMatrix();

  console.info('Service Worker: activated');
});

self.addEventListener('fetch', async (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // TODO(@zicklag): This is a weird thing we are doing to replace the need
  // for the nginx / fastly / etc. rewrite rules that were previously being used.
  // I'm not sure why this WASM binary is always resolved with a relative path,
  // but it would be good to fix that so that we don't need this anymore.
  if (url.pathname.endsWith('olm.wasm')) {
    event.respondWith(fetch('/olm.wasm'));
    return;
  }

  if (url.pathname.startsWith('/_matrix')) {
    event.respondWith(
      (async () => {
        if (!matrixShim) {
          await tryInitMatrix();
        }
        if (!matrixShim) {
          return new Response(null, { status: 500, statusText: 'Matrix: not ready yet' });
        }
        return matrixShim.handleRequest(event.request);
      })()
    );
  }
});
