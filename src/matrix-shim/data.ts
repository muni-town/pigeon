/* eslint-disable no-continue */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable no-console */
/* eslint-disable no-restricted-syntax */
/* eslint-disable max-classes-per-file */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ICreateRoomOpts, IRoomEvent, IStateEvent } from 'matrix-js-sdk';

import * as earthstar from '@earthstar/earthstar';
import _ from 'lodash';
import { ulid } from 'ulidx';
import { MatrixShim } from '.';
import { resolvePublicKey, urlToMxc } from './resolve';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
function encodeText(text: string): Uint8Array {
  return textEncoder.encode(text);
}
function decodeText(binary: Uint8Array): string {
  return textDecoder.decode(binary);
}
function encodeJson(data: any): Uint8Array {
  return encodeText(JSON.stringify(data));
}
function decodeJson<T>(binary: Uint8Array): T {
  return JSON.parse(decodeText(binary));
}

// type Message = {
//   txId: string;
//   sender: string;
//   sentAt: number;
//   message: string;
// };

// export type Member = { id: string; displayname?: string; avatar_url?: string };

// type Rooms = {
//   [id: string]: {
//     direct: boolean;
//     name: string;
//     owner: Member;
//     members: Member[];
//     createdAt: number;
//     messages: Message[];
//   };
// };

export type RoomInfo = {
  $type: 'town.muni.pigeon.room';
};
export type ShareInfo = RoomInfo;

export class MatrixDataWrapper {
  m: MatrixShim;

  constructor(m: MatrixShim) {
    this.m = m;
  }

  async createRoom(opts: ICreateRoomOpts): Promise<string> {
    if (!this.m.auth) throw new Error('Not logged in');

    // Get the list of members and their metadata
    const dids = [this.m.auth.session.did, ...(opts.invite || [])];
    const resp = await this.m.auth.agent.getProfiles({
      actors: dids,
    });
    let members = (
      await Promise.all(
        _.zip(dids, resp.data.profiles).map(async ([did, profile]) => ({
          id: did!,
          displayname: profile?.handle,
          avatar_url: profile?.avatar && urlToMxc(profile.avatar),
          'town.muni.pigeon.publicKey': (await resolvePublicKey(did!))!,
        }))
      )
    ).filter((x) => {
      if (!x['town.muni.pigeon.publicKey']) {
        console.warn(`Could not resolve public key for ${x.id}. Not adding to room members.`);
        return false;
      }
      return true;
    });

    // Create a share for the room
    const share = await this.m.earthPeer.createShare('room', false);
    if (earthstar.isErr(share)) throw share;

    // Mint capability for all room members ( for now all members have full write access )
    members = await Promise.all(
      members.map(async (member) => {
        const cap = await this.m.earthPeer.mintCap(
          share.tag,
          member['town.muni.pigeon.publicKey'],
          'write'
        );
        if (earthstar.isErr(cap)) throw cap;
        return { ...member };
      })
    );

    // Get the room store
    const store = await this.m.earthPeer.getStore(share.tag);
    if (earthstar.isErr(store)) throw store;

    // Create a record marking this as a pigeon room
    await store.set({
      identity: this.m.auth.identity,
      path: earthstar.Path.fromStrings('self'),
      payload: encodeJson({ $type: 'town.muni.pigeon.room' } as ShareInfo),
      timestamp: BigInt(Date.now()),
    });

    // Create the room create state event
    await store.set({
      identity: this.m.auth.identity,
      path: earthstar.Path.fromStrings('events', 'state', ulid()),
      timestamp: BigInt(Date.now()),
      payload: encodeJson({
        event_id: ulid(),
        type: 'm.room.create',
        content: {
          creator: this.m.auth.session.did,
        },
        state_key: '',
        origin_server_ts: Date.now(),
        sender: this.m.auth.session.did,
      } as IStateEvent),
    });

    // Add join events for all the members
    for (const member of members) {
      // eslint-disable-next-line no-await-in-loop
      await store.set({
        identity: this.m.auth.identity,
        path: earthstar.Path.fromStrings('events', 'state', ulid()),
        timestamp: BigInt(Date.now()),
        payload: encodeJson({
          event_id: ulid(),
          type: 'm.room.member',
          content: {
            membership: 'join',
            avatar_url: member.avatar_url,
            displayname: member.displayname,
          },
          state_key: member.id,
          origin_server_ts: Date.now(),
          sender: member.id,
        } as IStateEvent),
      });
    }

    // Set the room name
    await store.set({
      identity: this.m.auth.identity,
      path: earthstar.Path.fromStrings('events', 'state', ulid()),
      timestamp: BigInt(Date.now()),
      payload: encodeJson({
        event_id: ulid(),
        type: 'm.room.name',
        content: {
          name:
            opts.name ||
            opts.room_alias_name ||
            (opts.is_direct &&
              members
                .slice(1)
                .map((x) => x.displayname)
                .filter((x) => !!x)
                .join(', ')) ||
            'New Room',
        },
        state_key: '',
        origin_server_ts: Date.now(),
        sender: this.m.auth.session.did,
      } as IStateEvent),
    });

    return share.tag;
  }

  async roomState(roomId: string): Promise<IStateEvent[]> {
    const store = await this.m.earthPeer.getStore(roomId);
    if (earthstar.isErr(store)) return [];

    const events: IStateEvent[] = [];

    const docs = store.queryDocs({
      pathPrefix: earthstar.Path.fromStrings('events', 'state'),
      order: 'timestamp',
    });
    for await (const doc of docs) {
      const data = doc.payload;
      if (!data) continue;
      events.push(decodeJson(await data.bytes(0)));
    }

    return events;
  }

  async roomSendMessage(
    roomId: string,
    type: string,
    _txId: string,
    content: any
  ): Promise<string> {
    if (!this.m.auth) throw new Error('Not logged in');
    const store = await this.m.earthPeer.getStore(roomId);
    if (earthstar.isErr(store)) throw store;

    const eventId = ulid();
    const status = await store.set({
      identity: this.m.auth.identity,
      path: earthstar.Path.fromStrings('events', 'timeline', eventId),
      timestamp: BigInt(Date.now()),
      payload: encodeJson({
        type,
        event_id: eventId,
        origin_server_ts: Date.now(),
        sender: this.m.auth.session.did,
        content,
      }),
    });

    if (status.kind === 'failure') console.error('Got failure sending chat.');

    return eventId;
  }

  async roomMessages(
    roomId: string,
    direction: 'forward' | 'backward',
    from?: string,
    to?: string,
    limit = 10
  ): Promise<
    | {
        start: string;
        end?: string;
        state: IStateEvent[];
        chunk: IRoomEvent[];
        roomCreatedAt: number;
      }
    | undefined
  > {
    if (!this.m.auth) throw new Error('Not logged in');
    const store = await this.m.earthPeer.getStore(roomId);
    if (earthstar.isErr(store)) throw store;

    const roomInfo = await store.latestDocAtPath(earthstar.Path.fromStrings('self'));
    if (earthstar.isErr(roomInfo)) throw roomInfo;
    if (!roomInfo) return undefined;

    const start = BigInt(from || roomInfo.timestamp);
    const until = to ? BigInt(to) : undefined;

    const state = await this.roomState(roomId);

    const query = {
      limit,
      order: 'timestamp',
      pathPrefix: earthstar.Path.fromStrings('events'),
      descending: direction === 'backward',
      timestampGte: direction === 'forward' ? start : until,
      timestampLt: direction === 'backward' ? start : until,
    } as earthstar.Query;
    const docs = store.queryDocs(query);

    const chunk = [];
    for await (const doc of docs) {
      if (!doc.payload) continue;
      const data = await doc.payload?.bytes();
      chunk.push(decodeJson(data));
    }

    return { start: start.toString(), chunk, state, roomCreatedAt: Number(roomInfo.timestamp) };
  }

  /** Get the direct messages account data for a user */
  accountDataDirect(userId: string): { type: 'm.direct'; content: { [userId: string]: string[] } } {
    // const data: { [userId: string]: string[] } = {};
    // const directRooms = Object.entries(this.data.rooms)
    //   .filter(([, room]) => room.direct)
    //   .filter(([, room]) => room.members.some((x) => x.id === userId) || room.owner.id === userId);
    // for (const [id, room] of directRooms) {
    //   if (room.owner.id !== userId) {
    //     data[room.owner.id] = [...(data[room.owner.id] || []), id];
    //   }
    //   for (const member of room.members) {
    //     if (member.id !== userId) {
    //       data[member.id] = [...(data[member.id] || []), id];
    //     }
    //   }
    // }
    // return {
    //   type: 'm.direct',
    //   // content: data,
    //   content: {},
    // };
  }
}
