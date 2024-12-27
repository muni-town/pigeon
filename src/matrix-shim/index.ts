/// <reference lib="WebWorker" />
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable max-classes-per-file */

import { AutoRouter, AutoRouterType, error, IRequest, withContent } from 'itty-router';
import { type IRooms, type ILoginParams } from 'matrix-js-sdk';
import {
  BrowserOAuthClient,
  OAuthClientMetadataInput,
  OAuthSession,
  atprotoLoopbackClientMetadata,
  buildLoopbackClientId,
} from '@atproto/oauth-client-browser';
import { Agent } from '@atproto/api';

import { KVSIndexedDB, kvsIndexedDB } from '@kvs/indexeddb';

import * as earthstar from '@earthstar/earthstar';
import * as earthstarBrowser from '@earthstar/earthstar/browser';

async function resolveHandle(did: string): Promise<string> {
  const resp = await fetch(`https://plc.directory/${did}`);
  const json = await resp.json();
  const handleUri = json?.alsoKnownAs[0];
  const handle = handleUri.split('at://')[1];
  return handle;
}

class Notifier {
  resolve: () => void;

  promise: Promise<void>;

  constructor() {
    let resolve: () => void = () => {
      /**/
    };
    this.promise = new Promise((r) => {
      resolve = r;
    });
    this.resolve = resolve;
  }

  notify() {
    this.resolve();
    this.promise = new Promise((r) => {
      this.resolve = r;
    });
  }

  wait(): Promise<void> {
    return this.promise;
  }
}

const data: { rooms: IRooms } = {
  rooms: {
    invite: {},
    knock: {},
    leave: {},
    join: {
      '!OEOSqbsIkqLoDShXXD:matrix.org': {
        ephemeral: {
          events: [],
        },
        account_data: {
          events: [],
        },
        state: {
          events: [
            {
              content: {
                creator: 'did:plc:ulg2bzgrgs7ddjjlmhtegk3v',
                room_version: '10',
              },
              origin_server_ts: 1735057902140,
              sender: 'did:plc:ulg2bzgrgs7ddjjlmhtegk3v',
              state_key: '',
              type: 'm.room.create',
              event_id: '$7czg7NYYTIzxF-JtPeEkSJJGKnHkn_okjkevmxRA38I',
              room_id: '!OEOSqbsIkqLoDShXXD:matrix.org',
            },
            {
              content: {
                membership: 'join',
              },
              origin_server_ts: 1735057902636,
              sender: 'did:plc:ulg2bzgrgs7ddjjlmhtegk3v',
              state_key: 'did:plc:ulg2bzgrgs7ddjjlmhtegk3v',
              type: 'm.room.member',
              event_id: '$WqODkAUHobazMKXy8x9SE33ww1ArJqJi_iDKxeX204I',
            },
            {
              content: {
                name: 'test-matrix-room',
              },
              origin_server_ts: 1735057903889,
              sender: 'did:plc:ulg2bzgrgs7ddjjlmhtegk3v',
              state_key: '',
              type: 'm.room.name',
              event_id: '$4AYeUhoiOr1rFeYPOxNFRQhauGGNxd3OdSJAfhB_nQ8',
              room_id: '!OEOSqbsIkqLoDShXXD:matrix.org',
            },
          ],
        },
        timeline: {
          events: [],
          prev_batch: '0',
        },
        unread_notifications: {
          notification_count: 0,
          highlight_count: 0,
        },
        summary: {
          'm.heroes': [],
        },
      },
    },
  },
};

export class MatrixShim {
  clientConfig: { [key: string]: any };

  peer: earthstar.Peer;

  sessionId: string;

  oauthClient: BrowserOAuthClient;

  oauthSession: OAuthSession | undefined;

  bskyAgent: Agent | undefined;

  userHandle = '';

  clientRedirectUrl = '';

  changes: Notifier;

  router: AutoRouterType<IRequest, any[], any>;

  kvdb: KVSIndexedDB<{ did: string | undefined }>;

  private constructor(
    clientConfig: { [key: string]: any },
    peer: earthstar.Peer,
    sessionId: string,
    oauthClient: BrowserOAuthClient,
    kvdb: KVSIndexedDB<{ did: string | undefined }>
  ) {
    this.clientConfig = clientConfig;
    this.peer = peer;
    this.sessionId = sessionId;
    this.oauthClient = oauthClient;
    this.changes = new Notifier();
    this.kvdb = kvdb;

    const router = AutoRouter();

    router.get('/_matrix/client/versions', () => ({
      versions: ['v1.13'],
    }));

    router.get('/_matrix/login/sso/redirect', async ({ query }) => {
      if (!query.redirectUrl) return error(400, 'missing required `redirectUrl` query parameter.');
      this.clientRedirectUrl = query.redirectUrl as string;
      const url = await this.oauthClient.authorize('https://bsky.social', {
        state: this.sessionId,
      });
      return new Response(null, { status: 302, headers: [['location', url.href]] });
    });

    router.get('/_matrix/custom/oauth/callback', async ({ url }) => {
      const params = new URL(url).searchParams;
      const { session } = await this.oauthClient.callback(params);
      this.setOauthSession(session);

      const redirect = new URL(this.clientRedirectUrl);
      redirect.searchParams.append('loginToken', this.sessionId);
      return new Response(null, { status: 302, headers: [['location', redirect.href]] });
    });

    const authFlows = {
      flows: [
        {
          type: 'm.login.sso',
          identity_providers: [
            {
              id: 'oauth-atproto',
              name: 'BlueSky',
              brand: 'bluesky',
            },
          ],
        },
        {
          type: 'm.login.token',
        },
      ],
      session: this.sessionId,
    };
    router.get('/_matrix/client/v3/login', () => authFlows);
    router.post('/_matrix/client/v3/login', withContent, ({ content }) => {
      if (!content) return error(400, 'Invalid login request');
      const req = content as ILoginParams;

      return {
        access_token: this.sessionId,
        device_id: req.device_id || sessionId,
        user_id: this.oauthSession?.did,
      };
    });

    //
    // AUTH CHECK
    //

    // All below this route require auth
    // eslint-disable-next-line consistent-return
    router.all('*', async () => {
      if (!this.oauthSession) {
        return error(401, {
          errcode: 'M_UNKNOWN_TOKEN',
          error: 'AtProto session expired',
          soft_logout: true,
        });
      }
    });

    router.get('/_matrix/client/v3/pushrules/', () => []);
    router.get('/_matrix/client/v3/voip/turnServer', () => []);
    router.get('/_matrix/client/v3/devices', () => []);
    router.get('/_matrix/client/v3/room_keys/version', () => ({}));
    router.get('/_matrix/media/v3/config', () => ({
      'm.upload.size': 10 * 1024 * 1024,
    }));
    router.get('/_matrix/client/v3/capabilities', () => ({
      capabilities: {},
    }));

    router.post('/_matrix/client/v3/keys/query', () => ({}));
    router.post('/_matrix/client/v3/keys/upload', () => ({}));
    router.post('/_matrix/client/v3/user/:userId/filter', () => ({
      filter_id: '1',
    }));
    router.get('/_matrix/client/v3/user/:userId/filter/:filterId', () => ({}));

    router.get('/_matrix/client/v3/voip/turnServer ', () => ({}));

    router.get('/_matrix/client/v3/profile/:userId', async ({ params }) => ({
      displayname: await resolveHandle(decodeURIComponent(params.userId)),
    }));

    router.get('/_matrix/client/v3/rooms/:roomId/members', ({ params }) => {
      const roomId = decodeURIComponent(params.roomId);
      return {
        chunk: data.rooms.join[roomId].state.events.filter((x) => x.type === 'm.room.member'),
      };
    });
    router.get('/_matrix/client/v3/rooms/:roomId/messages', ({ params, query }) => {
      const roomId = decodeURIComponent(params.roomId);
      const events = [...data.rooms.join[roomId].timeline.events];
      if (query.dir === 'b') events.reverse();
      return {
        chunk: events,
        start: query.from || '0',
      };
    });

    router.put('/_matrix/client/v3/rooms/:roomId/typing/:userId', () => ({}));

    router.put(
      '/_matrix/client/v3/rooms/:roomId/send/:type/:txnId',
      withContent,
      ({ params, content }) => {
        const roomId = decodeURIComponent(params.roomId);
        const eventId = crypto.randomUUID();
        data.rooms.join[roomId].timeline.events.push({
          type: params.type,
          content,
          sender: this.userHandle,
          event_id: eventId,
          state_key: '',
          origin_server_ts: Date.now(),
          room_id: roomId,
        });

        this.changes.notify();

        return {
          event_id: eventId,
        };
      }
    );

    router.get('/_matrix/client/v3/sync', async ({ query }) => {
      if (!query.since) {
        return {
          next_batch: Date.now(),
          ...data,
        };
      }

      const since = parseInt(query.since as string, 10);

      const d = { ...data };

      if (
        query.timeout !== '0' &&
        !Object.values(d.rooms.join).some((x) =>
          x.timeline.events.some((y) => y.origin_server_ts > since)
        )
      ) {
        Promise.race([
          await this.changes.wait(),
          new Promise((resolve) => {
            setTimeout(resolve, parseInt(query.timeout as string, 10) || 30000);
          }),
        ]);
      }

      Object.values(d.rooms.join).forEach((room) => {
        // eslint-disable-next-line no-param-reassign
        room.timeline.events = room.timeline.events.filter((x) => x.origin_server_ts > since);
      });
      return {
        next_batch: Date.now(),
        ...d,
      };
    });

    this.router = router;
  }

  async setOauthSession(session: OAuthSession) {
    this.oauthSession = session;
    this.bskyAgent = new Agent(this.oauthSession);
    this.userHandle = await resolveHandle(this.oauthSession.did);
    this.kvdb.set('did', this.oauthSession.did);
  }

  static async init(): Promise<MatrixShim> {
    const clientconfigResp = await fetch('/config.json');
    const clientConfig = await clientconfigResp.json();

    const peer = new earthstar.Peer({
      password: 'password',
      runtime: new earthstar.RuntimeDriverUniversal(),
      storage: new earthstarBrowser.StorageDriverIndexedDB(),
    });

    const sessionId: string =
      Math.random().toString() + Math.random().toString() + Math.random().toString();

    const redirectUri = new URL(globalThis.location.href);
    redirectUri.pathname = '/_matrix/custom/oauth/callback';
    let metadata: OAuthClientMetadataInput;
    if (clientConfig.oauthClientId) {
      const resp = await fetch(clientConfig.oauthClientId, {
        headers: [['accept', 'application/json']],
      });
      metadata = await resp.json();
    } else {
      metadata = {
        ...atprotoLoopbackClientMetadata(buildLoopbackClientId(new URL('http://127.0.0.1:8080'))),
        redirect_uris: [redirectUri.href],
        client_id: `http://localhost?redirect_uri=${encodeURIComponent(redirectUri.href)}`,
      };
    }
    const oauthClient = new BrowserOAuthClient({
      handleResolver: 'https://bsky.social',
      clientMetadata: metadata,
      responseMode: 'query',
      allowHttp: true,
    });

    const shim = new MatrixShim(
      clientConfig,
      peer,
      sessionId,
      oauthClient,
      await kvsIndexedDB({ name: 'matrix-shim', version: 1 })
    );

    // TODO: This does not work because the `.restore()` method requires localStorage which does not exist in service workers.
    // Try to restore previous session
    // const did = await shim.kvdb.get('did');
    // if (did) {
    //   oauthClient.restore(did).then((x) => {
    //     shim.setOauthSession(x);
    //   });
    // }

    return shim;
  }

  async handleRequest(request: Request): Promise<Response> {
    return this.router.fetch(request);
  }
}
