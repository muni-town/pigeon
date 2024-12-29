/* eslint-disable no-restricted-syntax */
/* eslint-disable max-classes-per-file */
/* eslint-disable @typescript-eslint/no-explicit-any */
import _ from 'lodash';
import { ICreateRoomOpts, IRoomEvent, IStateEvent } from 'matrix-js-sdk';

type Message = {
  txId: string;
  sender: string;
  sentAt: number;
  message: string;
};

type Rooms = {
  [id: string]: {
    direct: boolean;
    name: string;
    owner: { id: string; displayname?: string };
    members: { id: string; displayname?: string }[];
    createdAt: number;
    messages: Message[];
  };
};

export class Data {
  rooms: Rooms = {};

  constructor() {
    this.rooms = JSON.parse(localStorage.getItem('matrix-shim-rooms') || '{}');
  }

  save() {
    localStorage.setItem('matrix-shim-rooms', JSON.stringify(this.rooms));
  }

  createRoom(
    owner: { id: string; displayname?: string },
    members: { id: string; displayname?: string }[],
    name: string,
    direct: boolean
  ): string {
    const id = `!${crypto.randomUUID()}:pigeon`;
    this.rooms[id] = {
      direct,
      createdAt: Date.now(),
      name,
      owner,
      members,
      messages: [],
    };
    this.save();
    return id;
  }
}

function roomMemberEventId(roomId: string, memberId: string, timestamp: number): string {
  return `m.room.member-${roomId}-${memberId}-${timestamp}`;
}

function roomMessageEventId(
  roomId: string,
  sender: string,
  txid: string,
  timestamp: number
): string {
  return `m.room.message-${roomId}-${sender}-${txid}-${timestamp}`;
}

export class MatrixDataWrapper {
  data: Data = new Data();

  get rooms(): Rooms {
    return this.data.rooms;
  }

  async createRoom(
    owner: { id: string; displayname?: string },
    opts: ICreateRoomOpts,
    resolveDid: (did: string) => Promise<string | undefined>
  ): Promise<string> {
    let name = 'New Room';
    if (opts.name) name = opts.name;
    if (!opts.name && opts.invite && opts.invite.length > 0) {
      const handles = await Promise.all(opts.invite.map(resolveDid));
      const zip = _.zip(opts.invite, handles) as [string, string | undefined][];
      name = zip.map(([did, handle]) => handle || did).join(', ');
    }

    return this.data.createRoom(
      owner,
      await Promise.all(
        (opts.invite || []).map(async (id) => ({ id, displayname: await resolveDid(id) }))
      ),
      name,
      opts.is_direct || false
    );
  }

  roomIds(): string[] {
    return Object.keys(this.data.rooms);
  }

  roomState(roomId: string): IStateEvent[] {
    const room = this.data.rooms[roomId];

    const state = [room.owner, ...room.members].map((member) => ({
      type: 'm.room.member',
      event_id: roomMemberEventId(roomId, member.id, room.createdAt),
      content: {
        membership: 'join',
        displayname: member.displayname,
      },
      origin_server_ts: room.createdAt,
      sender: member.id,
      state_key: member.id,
    }));

    state.push({
      type: 'm.room.name',
      event_id: `m.room.name-${roomId}-${room.createdAt}`,
      content: {
        name: room.name,
      } as any,
      origin_server_ts: room.createdAt,
      sender: room.owner.id,
      state_key: '',
    });

    return state;
  }

  roomSendMessage(roomId: string, sender: string, txId: string, message: string): string {
    const room = this.data.rooms[roomId];
    if (!roomId) throw new Error(`Room does not exist`);
    const sentAt = Date.now();
    room.messages.push({
      message,
      sender,
      sentAt,
      txId,
    });
    this.data.save();
    return roomMessageEventId(roomId, sender, txId, sentAt);
  }

  roomMessages(
    roomId: string,
    direction: 'forward' | 'backward',
    from?: string,
    to?: string,
    limit = 10
  ): { start: string; end?: string; state: IStateEvent[]; chunk: IRoomEvent[] } | undefined {
    const room = this.data.rooms[roomId];
    if (!room) return undefined;

    let start: string;
    if (from) {
      start = from;
    } else if (direction === 'forward') {
      start = room.createdAt.toString();
    } else {
      const lastMessage = room.messages[room.messages.length - 1];
      start = lastMessage ? lastMessage.sentAt.toString() : room.createdAt.toString();
    }
    const toN = to && parseInt(to, 10);
    const startN = parseInt(start, 10);

    let end: string | undefined;
    const state = this.roomState(roomId);

    if (room.messages.length === 0) {
      return {
        start,
        chunk: [],
        state,
      };
    }
    let i = direction === 'forward' ? 0 : room.messages.length - 1;
    const chunk: IRoomEvent[] = [];
    while (chunk.length <= limit) {
      const message = room.messages[i];
      if (!message) break;
      if (chunk.length === limit) {
        if (message) {
          end = message.sentAt.toString();
        }
        break;
      }

      const startDiff = message.sentAt - startN;
      const dirn = direction === 'forward' ? 1 : -1;

      // If this message is within the range that we are looking for
      if (startDiff * dirn > 0) {
        const toDiff = toN && toN - message.sentAt;
        if (toDiff && toDiff * dirn > 0) {
          end = message.sentAt.toString();
          break;
        }
        chunk.push({
          type: 'm.room.message',
          event_id: roomMessageEventId(roomId, message.sender, message.txId, message.sentAt),
          content: {
            body: message.message,
            msgtype: 'm.text',
          },
          origin_server_ts: message.sentAt,
          sender: message.sender,
          room_id: roomId,
        });
      }

      if (direction === 'forward') {
        i += 1;
      } else {
        i -= 1;
      }
    }

    return { start, chunk, end, state };
  }

  /** Get the direct messages account data for a user */
  accountDataDirect(userId: string): { type: 'm.direct'; content: { [userId: string]: string[] } } {
    const data: { [userId: string]: string[] } = {};
    const directRooms = Object.entries(this.data.rooms)
      .filter(([, room]) => room.direct)
      .filter(([, room]) => room.members.some((x) => x.id === userId) || room.owner.id === userId);

    for (const [id, room] of directRooms) {
      if (room.owner.id !== userId) {
        data[room.owner.id] = [...(data[room.owner.id] || []), id];
      }

      for (const member of room.members) {
        if (member.id !== userId) {
          data[member.id] = [...(data[member.id] || []), id];
        }
      }
    }

    return {
      type: 'm.direct',
      content: data,
    };
  }
}
