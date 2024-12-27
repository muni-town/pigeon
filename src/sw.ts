/// <reference lib="WebWorker" />

import { MatrixShim } from './matrix-shim';

export type {};
declare const self: ServiceWorkerGlobalScope;

// async function askForAccessToken(client: Client): Promise<string | undefined> {
//   return new Promise((resolve) => {
//     const responseKey = Math.random().toString(36);
//     const listener = (event: ExtendableMessageEvent) => {
//       if (event.data.responseKey !== responseKey) return;
//       resolve(event.data.token);
//       self.removeEventListener('message', listener);
//     };
//     self.addEventListener('message', listener);
//     client.postMessage({ responseKey, type: 'token' });
//   });
// }

// function fetchConfig(token?: string): RequestInit | undefined {
//   if (!token) return undefined;

//   return {
//     headers: {
//       Authorization: `Bearer ${token}`,
//     },
//     cache: 'default',
//   };
// }

// Immediately activate new service workers.
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Immediately force all active clients to switch to the new service worker.
self.addEventListener('activate', () => {
  // zicklag: I'm not sure what this `waitUntil` was for, but I'm removing it for now.
  // event.waitUntil(self.clients.claim());

  self.clients.claim()
});

const matrixShim = MatrixShim.init();

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
    const shim = await matrixShim;
    event.respondWith(shim.handleRequest(event.request));
  }
  // const defaultHandler = () => {
  //   const { url, method } = event.request;
  //   if (method !== 'GET') return;
  //   if (
  //     !url.includes('/_matrix/client/v1/media/download') &&
  //     !url.includes('/_matrix/client/v1/media/thumbnail')
  //   ) {
  //     return;
  //   }
  //   event.respondWith(
  //     (async (): Promise<Response> => {
  //       const client = await self.clients.get(event.clientId);
  //       let token: string | undefined;
  //       if (client) token = await askForAccessToken(client);

  //       return fetch(url, fetchConfig(token));
  //     })()
  //   );
  // };

  // defaultHandler();
});
