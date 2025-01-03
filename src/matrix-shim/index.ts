/// <reference lib="WebWorker" />
/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable max-classes-per-file */

import {
  AutoRouter,
  AutoRouterType,
  error,
  IRequest,
  RequestHandler,
  withContent,
} from 'itty-router';
import { ICreateRoomOpts, type ILoginParams, type IRoomEvent, type IRooms } from 'matrix-js-sdk';
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
import { DataConnection } from 'peerjs';
import lexicons from './lexicon.json';
import { MatrixDataWrapper } from './data';
import { PeerjsConnectionManager } from './peerjsTransport';
import { Notifier } from './notifier';
import { resolveDidToHandle, urlToMxc } from './resolve';

export class MatrixShim {
  clientConfig: { [key: string]: any };

  earthPeer: earthstar.Peer;

  sessionId: string;

  oauthClient: BrowserOAuthClient;

  auth?: {
    session: OAuthSession;
    agent: Agent;
    identity: earthstar.IdentityTag;
  };

  connectionManager: PeerjsConnectionManager;

  webrtcPeerConns: { [did: string]: DataConnection } = {};

  userHandle = '';

  clientRedirectUrl = '';

  changes: Notifier;

  router: AutoRouterType<IRequest, any[], any>;

  kvdb: KVSIndexedDB<{ did: string | undefined }>;

  data: MatrixDataWrapper;

  /**
   * Initialize the MatrixShim.
   */
  static async init(): Promise<MatrixShim> {
    console.info('Initializing matrix shim');

    // Fetch the client Pigeon client configuration JSON
    const clientconfigResp = await fetch('/config.json');
    const clientConfig = await clientconfigResp.json();

    // Create a new earthstar peer
    const earthPeer = new earthstar.Peer({
      password: 'password',
      runtime: new earthstar.RuntimeDriverUniversal(),
      storage: new earthstarBrowser.StorageDriverIndexedDB(),
    });

    const sessionId: string =
      Math.random().toString() + Math.random().toString() + Math.random().toString();

    const redirectUri = new URL(globalThis.location.href);
    redirectUri.pathname = `${clientConfig.hashRouter.basename}_matrix/custom/oauth/callback`;
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
        scope: 'atproto transition:generic transition:chat.bsky',
        client_id: `http://localhost?redirect_uri=${encodeURIComponent(
          redirectUri.href
        )}&scope=${encodeURIComponent('atproto transition:generic transition:chat.bsky')}`,
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
      earthPeer,
      sessionId,
      oauthClient,
      await kvsIndexedDB({ name: 'matrix-shim', version: 1 })
    );

    // Try to restore previous session
    const did = await shim.kvdb.get('did');
    if (did) {
      oauthClient.restore(did).then((x) => {
        shim.setOauthSession(x);
      });
    }

    // Add to global scope for easier debugging in the browser console.
    (globalThis as any).matrix = shim;

    return shim;
  }

  /**
   * Crate the MatrixShim object.
   */
  private constructor(
    clientConfig: { [key: string]: any },
    earthPeer: earthstar.Peer,
    sessionId: string,
    oauthClient: BrowserOAuthClient,
    kvdb: KVSIndexedDB<{ did: string | undefined }>
  ) {
    this.clientConfig = clientConfig;
    this.earthPeer = earthPeer;
    this.sessionId = sessionId;
    this.oauthClient = oauthClient;
    this.changes = new Notifier('matrix');
    this.kvdb = kvdb;
    this.data = new MatrixDataWrapper(this);

    // Whenever a peer is opened, set that PeerId as our current peer ID in our AtProto PDS.
    this.connectionManager = new PeerjsConnectionManager({
      peerOpenHandlers: [
        () => {
          this.setPeerIdRecordInPds();
          this.connectToPeers();
        },
      ],
      peerConnectHandlers: [
        (_transport) => {
          (async () => {
            // for await (const message of transport) {
            //   for (const roomId of this.data.roomIds()) {
            //     const room = this.data.rooms[roomId];
            //     if (room.direct) {
            //       if (this.auth) {
            //         this.data.roomSendMessage(
            //           roomId,
            //           room.members[0].id,
            //           crypto.randomUUID(),
            //           new TextDecoder().decode(message)
            //         );
            //         this.changes.notify();
            //       }
            //     }
            //   }
            // }
          })();
        },
      ],
    });

    this.router = this.buildRouter();

    this.connectToPeers();
  }

  async setPeerIdRecordInPds() {
    if (this.auth) {
      await this.auth.agent.com.atproto.repo.putRecord({
        collection: 'peer.pigeon.muni.town',
        record: {
          $type: 'peer.pigeon.muni.town',
          id: this.connectionManager.peerId,
        },
        repo: this.auth.session.did,
        rkey: 'self',
      });
    }
  }

  /**
   * Set the current oauth session.
   */
  async setOauthSession(session: OAuthSession) {
    const oauthSession = session;
    const agent = new Agent(oauthSession);
    lexicons.forEach((l) => agent?.lex.add(l as any));
    this.userHandle = (await resolveDidToHandle(oauthSession.did)) || oauthSession.did;
    this.kvdb.set('did', oauthSession.did);

    const resp = await agent.call('key.pigeon.muni.town', undefined, undefined, {
      headers: {
        'atproto-proxy': 'did:web:keyserver.pigeon.muni.town#pigeon_keyserver',
      },
    });
    this.earthPeer.addExistingIdentity({
      tag: resp.data.publicKey,
      secretKey: resp.data.secretKey,
    });
    const identity = resp.data.publicKey;

    this.auth = {
      agent,
      identity,
      session,
    };

    this.connectToPeers();
  }

  async getPeerIdForDid(did: string): Promise<string | undefined> {
    if (this.auth) {
      const record = await this.auth.agent.com.atproto.repo.getRecord(
        {
          collection: 'peer.pigeon.muni.town',
          repo: did,
          rkey: 'self',
        },
        { headers: { 'atproto-proxy': `${did}#atproto_pds` } }
      );

      return (record.data.value as any)?.id;
    }

    return undefined;
  }

  /** Connect to all peers */
  async connectToPeers() {
    // console.info('Connecting to peers');
    // const membersList: Set<string> = new Set();
    // for (const roomId of this.data.roomIds()) {
    //   const room = this.data.rooms[roomId];
    //   membersList.add(room.owner.id);
    //   room.members.forEach((x) => membersList.add(x.id));
    // }
    // if (this.auth) membersList.delete(this.auth.session.did);
    // console.log('Peer dids:', membersList);
    // const ids = await Promise.all(
    //   [...membersList.values()].map(async (x) => [x, await this.getPeerIdForDid(x)])
    // );
    // console.log('Peer ids:', ids);
    // for (const [did, peerId] of ids) {
    //   if (peerId) {
    //     console.info('Connecting to peer', peerId);
    //     const transport = await this.connectionManager.connect(peerId);
    //     (async () => {
    //       for await (const message of transport) {
    //         for (const roomId of this.data.roomIds()) {
    //           const room = this.data.rooms[roomId];
    //           if (room.direct && room.members.some((x) => x.id === did)) {
    //             if (this.auth) {
    //               this.data.roomSendMessage(
    //                 roomId,
    //                 did!,
    //                 crypto.randomUUID(),
    //                 new TextDecoder().decode(message)
    //               );
    //               this.changes.notify();
    //             }
    //           }
    //         }
    //       }
    //     })();
    //   }
    // }
  }

  /** Build the matrix API routes. */
  buildRouter(): AutoRouterType {
    const router = AutoRouter();

    router.get('/_matrix/client/versions', () => ({
      versions: ['v1.13'],
    }));

    router.get('/_matrix/login/sso/redirect', async ({ query }) => {
      if (!query.redirectUrl) return error(400, 'missing required `redirectUrl` query parameter.');
      this.clientRedirectUrl = query.redirectUrl as string;
      const url = await this.oauthClient.authorize('https://bsky.social', {
        state: this.sessionId,
        scope: 'atproto transition:generic transition:chat.bsky',
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
        device_id: req.device_id || this.sessionId,
        user_id: this.auth?.session.did,
      };
    });

    router.post('/_matrix/client/v3/user_directory/search', withContent, async ({ content }) => {
      const c = content as { search_term: string };
      const results = [];
      if (c.search_term.startsWith('did:')) {
        const handle = await resolveDidToHandle(c.search_term);
        if (handle) {
          results.push({ user_id: c.search_term, display_name: handle });
        }
      } else if (this.auth) {
        const resp = await this.auth.agent.resolveHandle({ handle: c.search_term });
        if (resp.data.did) {
          const profile = await this.auth.agent!.getProfile({ actor: resp.data.did });
          results.push({
            user_id: resp.data.did,
            display_name: c.search_term,
            avatar_url: profile?.data.avatar && urlToMxc(profile.data.avatar),
          });
        }
      }
      this.changes.notify();
      return { limited: false, results };
    });

    //
    // AUTH CHECK
    //

    // All below this route require auth
    // eslint-disable-next-line consistent-return
    router.all('*', async () => {
      if (!this.auth) {
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

    const getMedia: RequestHandler = async ({ params }) => {
      if (params.serverName !== 'pigeon') {
        return error(404, 'Server name must be `pigeon`.');
      }
      // For now the only media IDs we support are base64 encoded URLs to redirect to.
      const url = atob(params.mediaId);
      return new Response(null, { status: 307, headers: [['location', url]] });
    };
    router.get('/_matrix/media/v3/thumbnail/:serverName/:mediaId', getMedia);
    router.get('/_matrix/media/v3/thumbnail/:serverName/:mediaId', getMedia);

    router.get('/_matrix/client/v3/profile/:userId', async ({ params }) => {
      const did = decodeURIComponent(params.userId);
      const handle = await resolveDidToHandle(did);
      const profile = await this.auth?.agent.getProfile({ actor: did });
      const avatar = profile?.data.avatar;
      const avatarUrl = avatar && urlToMxc(avatar);
      return {
        displayname: handle,
        avatar_url: avatarUrl,
      };
    });

    router.get('/_matrix/client/v3/rooms/:roomId/members', async ({ params }) => {
      const roomId = decodeURIComponent(params.roomId);
      return {
        chunk: await this.data.roomState(roomId),
      } as {
        chunk: IRoomEvent[];
      };
    });
    router.get('/_matrix/client/v3/rooms/:roomId/messages', ({ params, query }) => {
      const roomId = decodeURIComponent(params.roomId);
      return this.data.roomMessages(
        roomId,
        query.d === 'f' ? 'forward' : 'backward',
        query.from?.toString(),
        query.to?.toString(),
        (query.limit && parseInt(query.limit.toString(), 10)) || undefined
      );
    });

    router.put('/_matrix/client/v3/user/:userId/account_data/:type', withContent, async () =>
      // this.data.setAccountData(params.userId, params.type, content);
      ({})
    );

    router.get('/_matrix/client/v3/user/:userId/account_data/:type', async ({ params }) => {
      if (params.type === 'm.direct') {
        return this.data.accountDataDirect(params.userId);
      }
      return error(404);
    });

    router.post('/_matrix/client/v3/createRoom', withContent, async ({ content }) => {
      const opts: ICreateRoomOpts = content;
      const roomId = await this.data.createRoom(opts);

      this.changes.notify();
      this.connectToPeers();
      return { room_id: roomId };
    });

    router.put('/_matrix/client/v3/rooms/:roomId/typing/:userId', () => ({}));
    router.post('/_matrix/client/v3/rooms/:roomId/receipt/:receiptType/:eventId', () => ({}));

    router.put(
      '/_matrix/client/v3/rooms/:roomId/send/:type/:txId',
      withContent,
      async ({ params, content }) => {
        const roomId = decodeURIComponent(params.roomId);

        const eventId = await this.data.roomSendMessage(roomId, params.type, params.txid, content);

        this.changes.notify();

        return {
          event_id: eventId,
        };
      }
    );

    router.get('/_matrix/client/v3/sync', async ({ query }) => {
      const since = query.since?.toString() || '0';
      const timeout = parseInt(query.timeout?.toString() || '0', 10);

      const rooms: IRooms = {
        invite: {},
        join: {},
        knock: {},
        leave: {},
      };

      let exitNext = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Clear rooms
        rooms.join = {};

        for (const roomId of await this.earthPeer.shares()) {
          const messages = await this.data.roomMessages(roomId, 'forward', since, undefined, 1e100);
          // eslint-disable-next-line no-continue
          if (!messages) continue;
          if (messages.chunk.length > 0 || messages.roomCreatedAt > BigInt(since)) {
            rooms.join[roomId] = {
              account_data: { events: [] },
              ephemeral: { events: [] },
              state: { events: messages.state },
              summary: { 'm.heroes': [] },
              timeline: { prev_batch: since, events: messages.chunk },
              unread_notifications: {},
            };
          }
        }

        if (Object.keys(rooms.join).length > 0 || timeout === 0 || exitNext) {
          break;
        } else {
          // eslint-disable-next-line no-await-in-loop
          await Promise.race([
            (async () => {
              await this.changes.wait();
              return 'change';
            })(),
            new Promise((resolve) => {
              setTimeout(() => {
                resolve('timeout');
              }, timeout);
            }),
          ]);

          exitNext = true;
        }
      }

      return {
        account_data: { events: [] },
        next_batch: Date.now().toString(),
        rooms,
      };
    });

    return router;
  }

  /**
   * Handle a matrix API request.
   */
  async handleRequest(request: Request): Promise<Response> {
    return this.router.fetch(request);
  }
}
