/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/// <reference lib="WebWorker" />
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
import { edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import {
  BrowserOAuthClient,
  OAuthClientMetadataInput,
  OAuthSession,
  atprotoLoopbackClientMetadata,
  buildLoopbackClientId,
} from '@atproto/oauth-client-browser';
import { Agent } from '@atproto/api';

import { KVSIndexedDB, kvsIndexedDB } from '@kvs/indexeddb';
import nacl from 'tweetnacl';

import * as earthstar from '@earthstar/earthstar';
import * as earthstarBrowser from '@earthstar/earthstar/browser';
import { Peer as WebrtcPeer } from 'peerjs';
import _ from 'lodash';

import { MatrixDataWrapper } from './data';

/**
 * Resolve a did to it's AtProto handle.
 */
// eslint-disable-next-line consistent-return
const handleCache: { [did: string]: string } = {};
// eslint-disable-next-line consistent-return
async function resolveDid(did: string): Promise<string | undefined> {
  if (handleCache[did]) return handleCache[did];
  try {
    const resp = await fetch(`https://plc.directory/${did}`);
    const json = await resp.json();
    const handleUri = json?.alsoKnownAs[0];
    const handle = handleUri.split('at://')[1];
    handleCache[did] = handle;
    return handle;
  } catch (_e) {
    // Ignore error
  }
}

/** Helper to convert a URL to a pigeon mxc:// url.
 *
 * All this does is base64 encode the URL as the media ID and add it to a pigeon.muni.town server.
 */
function urlToMxc(url: string) {
  return `mxc://pigeon/${btoa(url)}`;
}

/**
 * Helper class that allows you to wait on the next notification and send notifications.
 */
class Notifier {
  resolve: () => void;

  promise: Promise<void>;

  constructor() {
    let resolve: () => void = () => {
      // Do nothing
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

  async wait() {
    await this.promise;
  }
}

type Keypair = NonNullable<Awaited<ReturnType<earthstar.Peer['auth']['identityKeypair']>>>;

export class MatrixShim {
  clientConfig: { [key: string]: any };

  earthPeer: earthstar.Peer;

  sessionId: string;

  oauthClient: BrowserOAuthClient;

  oauthSession?: OAuthSession;

  agent?: Agent;

  webrtcPeer?: WebrtcPeer;

  userHandle = '';

  clientRedirectUrl = '';

  changes: Notifier;

  router: AutoRouterType<IRequest, any[], any>;

  kvdb: KVSIndexedDB<{ did: string | undefined }>;

  keypair: Keypair;

  data: MatrixDataWrapper = new MatrixDataWrapper();

  /**
   * Initialize the MatrixShim.
   */
  static async init(): Promise<MatrixShim> {
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
        scope: 'atproto transition:generic',
        client_id: `http://localhost?redirect_uri=${encodeURIComponent(
          redirectUri.href
        )}&scope=${encodeURIComponent('atproto transition:generic')}`,
      };
    }
    const oauthClient = new BrowserOAuthClient({
      handleResolver: 'https://bsky.social',
      clientMetadata: metadata,
      responseMode: 'query',
      allowHttp: true,
    });

    let keypair: Keypair | undefined;
    // eslint-disable-next-line no-restricted-syntax
    for await (const pair of earthPeer.auth.identityKeypairs()) {
      if (pair.publicKey.shortname === 'dflt') {
        keypair = pair;
        break;
      }
    }
    if (!keypair) {
      const key = await earthPeer.auth.createIdentityKeypair('dflt');
      if (key instanceof earthstar.EarthstarError) {
        throw new Error(`Error creating default identity: ${key.message}`);
      }
      keypair = key;
    }

    const shim = new MatrixShim(
      clientConfig,
      earthPeer,
      sessionId,
      oauthClient,
      await kvsIndexedDB({ name: 'matrix-shim', version: 1 }),
      keypair
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
    kvdb: KVSIndexedDB<{ did: string | undefined }>,
    keypair: Keypair
  ) {
    this.clientConfig = clientConfig;
    this.earthPeer = earthPeer;
    this.sessionId = sessionId;
    this.oauthClient = oauthClient;
    this.changes = new Notifier();
    this.kvdb = kvdb;
    this.keypair = keypair;

    const router = AutoRouter();

    router.get('/_matrix/custom/authchecktest', () => {
      const myDerived = {
        publicKey: edwardsToMontgomeryPub(this.keypair.publicKey.underlying),
        secretKey: edwardsToMontgomeryPriv(this.keypair.secretKey),
      };
      const other = nacl.sign.keyPair();
      const otherDerived = {
        publicKey: edwardsToMontgomeryPub(other.publicKey),
        secretKey: edwardsToMontgomeryPriv(other.secretKey),
      };
      const myNonce = nacl.randomBytes(nacl.box.nonceLength);
      const otherNonce = nacl.randomBytes(nacl.box.nonceLength);

      const myMessage = new TextEncoder().encode('hello1');
      const otherMessage = new TextEncoder().encode('hello2');

      // First I send my authenticated message
      const myEncrypted = nacl.box(myMessage, myNonce, otherDerived.publicKey, myDerived.secretKey);
      // And they validate it
      const otherValidated = nacl.box.open(
        myEncrypted,
        myNonce,
        myDerived.publicKey,
        otherDerived.secretKey
      );

      const otherEncrypted = nacl.box(
        otherMessage,
        otherNonce,
        myDerived.publicKey,
        otherDerived.secretKey
      );
      const myValidated = nacl.box.open(
        otherEncrypted,
        otherNonce,
        otherDerived.publicKey,
        myDerived.secretKey
      );

      return {
        otherValidated: otherValidated && new TextDecoder().decode(otherValidated),
        myValidated: myValidated && new TextDecoder().decode(myValidated),
      };
    });

    router.get('/_matrix/client/versions', () => ({
      versions: ['v1.13'],
    }));

    router.get('/_matrix/login/sso/redirect', async ({ query }) => {
      if (!query.redirectUrl) return error(400, 'missing required `redirectUrl` query parameter.');
      this.clientRedirectUrl = query.redirectUrl as string;
      const url = await this.oauthClient.authorize('https://bsky.social', {
        state: this.sessionId,
        scope: 'atproto transition:generic',
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

    router.post('/_matrix/client/v3/user_directory/search', withContent, async ({ content }) => {
      const c = content as { search_term: string };
      const results = [];
      if (c.search_term.startsWith('did:')) {
        const handle = await resolveDid(c.search_term);
        if (handle) {
          results.push({ user_id: c.search_term, display_name: handle });
        }
      } else if (this.agent) {
        const resp = await this.agent.resolveHandle({ handle: c.search_term });
        if (resp.data.did) {
          const profile = await this.agent!.getProfile({ actor: resp.data.did });
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
      const handle = await resolveDid(did);
      const profile = await this.agent?.getProfile({ actor: did });
      const avatar = profile?.data.avatar;
      const avatarUrl = avatar && urlToMxc(avatar);
      return {
        displayname: handle,
        avatar_url: avatarUrl,
      };
    });

    router.get('/_matrix/client/v3/rooms/:roomId/members', ({ params }) => {
      const roomId = decodeURIComponent(params.roomId);
      return {
        chunk: this.data.roomState(roomId),
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
      const data: ICreateRoomOpts = content;
      const dids = [this.oauthSession!.did, ...(data.invite || [])];
      const resp = await this.agent!.getProfiles({
        actors: dids,
      });
      const [owner, ...members] = _.zip(dids, resp.data.profiles).map(([did, profile]) => ({
        id: did!,
        displayname: profile?.handle,
        avatar_url: profile?.avatar && urlToMxc(profile.avatar),
      }));

      const roomId = await this.data.createRoom(
        owner,
        members,
        members.map((x) => x.displayname).join(', '),
        data.is_direct
      );
      this.changes.notify();
      return { room_id: roomId };
    });

    router.put('/_matrix/client/v3/rooms/:roomId/typing/:userId', () => ({}));

    router.put(
      '/_matrix/client/v3/rooms/:roomId/send/:type/:txId',
      withContent,
      ({ params, content }) => {
        const roomId = decodeURIComponent(params.roomId);

        // Ignore non-message events
        if (params.type !== 'm.room.message') {
          return { eventId: crypto.randomUUID() };
        }

        const eventId = this.data.roomSendMessage(
          roomId,
          this.oauthSession!.did,
          params.txid,
          content.body || '[unknown body]'
        );
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

        for (const roomId of this.data.roomIds()) {
          const messages = this.data.roomMessages(roomId, 'forward', since, undefined, 1e100);
          // eslint-disable-next-line no-continue
          if (!messages) continue;

          if (
            messages.chunk.length > 0 ||
            this.data.rooms[roomId].createdAt > parseInt(since, 10)
          ) {
            rooms.join[roomId] = {
              account_data: { events: [] },
              ephemeral: { events: [] },
              state: { events: messages.state },
              summary: { 'm.heroes': [] },
              timeline: { prev_batch: since, events: messages.chunk, limited: !!messages.end },
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
        account_data: { events: [this.data.accountDataDirect(this.oauthSession!.did)] },
        next_batch: Date.now().toString(),
        rooms,
      };
    });

    this.router = router;
  }

  /**
   * Set the current oauth session.
   */
  async setOauthSession(session: OAuthSession) {
    this.oauthSession = session;
    this.agent = new Agent(this.oauthSession);
    this.userHandle = (await resolveDid(this.oauthSession.did)) || this.oauthSession.did;
    this.kvdb.set('did', this.oauthSession.did);
    this.webrtcPeer = new WebrtcPeer(this.oauthSession.did);
  }

  /**
   * Handle a matrix API request.
   */
  async handleRequest(request: Request): Promise<Response> {
    return this.router.fetch(request);
  }
}
