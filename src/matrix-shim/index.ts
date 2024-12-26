import { AutoRouter, error, withContent } from 'itty-router';
import { type IRooms, type ILoginParams } from 'matrix-js-sdk';
import {
  BrowserOAuthClient,
  OAuthClientMetadataInput,
  OAuthSession,
  atprotoLoopbackClientMetadata,
  buildLoopbackClientId,
} from '@atproto/oauth-client-browser';

const sessionId: string =
  Math.random().toString() + Math.random().toString() + Math.random().toString();

let oauthSession: OAuthSession | undefined;
let clientRedirectUrl = '';

const redirectUri = 'http://127.0.0.1:8080/_matrix/custom/oauth/callback';
const metadata: OAuthClientMetadataInput = {
  ...atprotoLoopbackClientMetadata(buildLoopbackClientId(new URL('http://127.0.0.1:8080'))),
  redirect_uris: [redirectUri],
  client_id: `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}`,
};

const oauthClient = new BrowserOAuthClient({
  handleResolver: 'https://bsky.social',
  clientMetadata: metadata,
  responseMode: 'query',
  allowHttp: true,
});

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

let userId = '';
const changes = new Notifier();

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
                creator: '@zicklag:matrix.org',
                room_version: '10',
              },
              origin_server_ts: 1735057902140,
              sender: '@zicklag:matrix.org',
              state_key: '',
              type: 'm.room.create',
              event_id: '$7czg7NYYTIzxF-JtPeEkSJJGKnHkn_okjkevmxRA38I',
              room_id: '!OEOSqbsIkqLoDShXXD:matrix.org',
            },
            {
              content: {
                avatar_url: 'mxc://matrix.org/lFKPRrfRnoJXMHiiNSLdfQPD',
                displayname: 'Zicklag',
                membership: 'join',
              },
              origin_server_ts: 1735057902636,
              sender: '@zicklag:matrix.org',
              state_key: '@zicklag:matrix.org',
              type: 'm.room.member',
              event_id: '$WqODkAUHobazMKXy8x9SE33ww1ArJqJi_iDKxeX204I',
            },
            {
              content: {
                name: 'test-matrix-room',
              },
              origin_server_ts: 1735057903889,
              sender: '@zicklag:matrix.org',
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

export async function handleRequest(request: Request): Promise<Response> {
  const router = AutoRouter();

  router.get('/_matrix/client/versions', () => ({
    versions: ['v1.13'],
  }));

  router.get('/_matrix/login/sso/redirect', async ({ query }) => {
    if (!query.redirectUrl) return error(400, 'missing required `redirectUrl` query parameter.');
    clientRedirectUrl = query.redirectUrl as string;
    const url = await oauthClient.authorize('https://bsky.social', { state: sessionId });
    return new Response(null, { status: 302, headers: [['location', url.href]] });
  });

  router.get('/_matrix/custom/oauth/callback', async ({ url }) => {
    const params = new URL(url).searchParams;
    const { session } = await oauthClient.callback(params);
    oauthSession = session;
    const redirect = new URL(clientRedirectUrl);
    redirect.searchParams.append('loginToken', sessionId);
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
    session: sessionId,
  };
  router.get('/_matrix/client/v3/login', () => authFlows);
  router.post('/_matrix/client/v3/login', withContent, ({ content }) => {
    if (!content) return error(400, 'Invalid login request');
    const req = content as ILoginParams;
    userId = `@${(req.identifier as any)?.user || 'name'}:matrix.org`;

    return {
      access_token: sessionId,
      device_id: req.device_id || sessionId,
      user_id: userId,
    };
  });

  // All below this route require auth
  // eslint-disable-next-line consistent-return
  router.all('*', async () => {
    if (!oauthSession) {
      return error(401, authFlows);
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

  router.get('/_matrix/client/v3/profile/:userId', ({ params }) => ({
    displayName: params.userId.split(':')[0],
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
        sender: userId,
        event_id: eventId,
        state_key: '',
        origin_server_ts: Date.now(),
        room_id: roomId,
      });

      changes.notify();

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
      await changes.wait();
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

  return router.fetch(request);
}
