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
  if (ev.data === 'ready?') {
    if (matrixShim) {
      channel.postMessage({ ready: true });
    } else if (matrixShimInitError) {
      channel.postMessage({ error: matrixShimInitError });
    } else {
      channel.postMessage({ loading: true });
    }
  }
};

// Immediately activate new service workers.
self.addEventListener('install', async (event) => {
  console.info('Service worker installing...');

  // Don't wait to install this service worker.
  self.skipWaiting();

  // Initialize the matrix shim before finishing install
  event.waitUntil(
    (async () => {
      try {
        // Start initializing the matrix shim.
        const shim = await MatrixShim.init();
        console.trace('init finished');
        matrixShim = shim;
        channel.postMessage({ ready: true });
      } catch (e) {
        console.trace('init errored');
        matrixShimInitError = `${e}`;
        channel.postMessage({ error: e });
        throw e;
      }
    })()
  );

  console.info('Service worker done installing');

  // TODO: we may still end up waiting to update if we are currently in the middle of
  // responding to a request in the old service worker. We need to add an abort controller
  // so that we can kill all active requests.
});

// Immediately force all active clients to switch to the new service worker.
self.addEventListener('activate', async (event) => {
  console.info('Activating service worker');

  // Wait until we are certain we are receiving all client fetches.
  event.waitUntil(self.clients.claim());

  console.info('Service worker activated');
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
    if (!matrixShim) {
      event.respondWith(
        new Response(null, { status: 500, statusText: 'Matrix shim not ready yet' })
      );
      return;
    }
    event.respondWith(matrixShim.handleRequest(event.request));
  }
});
