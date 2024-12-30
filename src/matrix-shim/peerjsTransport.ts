/* eslint-disable max-classes-per-file */
/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Transport } from '@earthstar/earthstar';

import { IS_ALFIE, IS_BETTY } from '@earthstar/willow';
import { FIFO } from '@korkje/fifo';

import type { PeerjsBackendMessage, PeerjsFrontendMessage } from './peerjsFrontend';

type SyncRole = Transport['role'];

export class PeerjsTransport implements Transport {
  remotePeerId: string;

  peerId: string;

  connId: string;

  role: SyncRole;

  isClosed = false;

  received = new FIFO<ArrayBuffer>();

  sender: BroadcastChannel;

  receiver: BroadcastChannel;

  /** Open a new outgoing PeerJS connection. */
  static async accept(o: {
    remotePeerId: string;
    peerId: string;
    connId: string;
  }): Promise<PeerjsTransport> {
    const sender = new BroadcastChannel('matrix-shim-peerjs-backend');
    const receiver = new BroadcastChannel('matrix-shim-peerjs-frontend');
    return PeerjsTransport.init({
      role: IS_BETTY as any,
      sender,
      receiver,
      ...o,
    });
  }

  /** Open a new outgoing PeerJS connection. */
  static async connect(remotePeerId: string): Promise<PeerjsTransport> {
    const sender = new BroadcastChannel('matrix-shim-peerjs-backend');
    const receiver = new BroadcastChannel('matrix-shim-peerjs-frontend');
    const transportId = crypto.randomUUID();

    const connInfo = new Promise<{ connId: string; peerId: string }>((resolve) => {
      const listener = (event: MessageEvent) => {
        // eslint-disable-next-line prefer-destructuring
        const data: PeerjsFrontendMessage = event.data;

        if (data.type === 'connOpened' && data.transportId === transportId) {
          receiver.removeEventListener('message', listener);

          resolve({ connId: data.connectionId, peerId: data.peerId });
        }
      };
      receiver.addEventListener('message', listener);
    });

    const m: PeerjsBackendMessage = { type: 'connect', remotePeerId, transportId };
    sender.postMessage(m);

    const { connId, peerId } = await connInfo;
    return PeerjsTransport.init({
      role: IS_ALFIE as any,
      connId,
      peerId,
      sender,
      receiver,
      remotePeerId,
    });
  }

  private static async init(o: {
    role: SyncRole;
    remotePeerId: string;
    connId: string;
    peerId: string;
    sender: BroadcastChannel;
    receiver: BroadcastChannel;
  }): Promise<PeerjsTransport> {
    const t = new PeerjsTransport(o);

    o.receiver.addEventListener('message', (event) => {
      // eslint-disable-next-line prefer-destructuring
      const data: PeerjsFrontendMessage = event.data;

      if (data.type === 'connClosed' && data.connectionId === t.connId) {
        t.isClosed = true;
      } else if (data.type === 'connData' && data.connectionId === t.connId) {
        t.received.push(data.data as Uint8Array);
      }
    });

    return t;
  }

  constructor(o: {
    role: SyncRole;
    remotePeerId: string;
    connId: string;
    peerId: string;
    sender: BroadcastChannel;
    receiver: BroadcastChannel;
  }) {
    this.role = o.role;
    this.connId = o.connId;
    this.remotePeerId = o.remotePeerId;
    this.peerId = o.peerId;
    this.sender = o.sender;
    this.receiver = o.receiver;
  }

  async send(bytes: Uint8Array): Promise<void> {
    const m: PeerjsBackendMessage = {
      type: 'sendData',
      connectionId: this.connId,
      peerId: this.peerId,
      data: bytes,
    };
    this.sender.postMessage(m);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for await (const msg of this.received) {
      if (this.isClosed) {
        break;
      }

      yield new Uint8Array(msg);
    }
  }

  close(): void {
    this.isClosed = true;
    const m: PeerjsBackendMessage = {
      type: 'closeConn',
      peerId: this.peerId,
      connectionId: this.connId,
    };
    this.sender.postMessage(m);
  }
}

type ConnectHandler = (ev: PeerjsTransport) => unknown;

export class PeerjsConnectionManager {
  sender = new BroadcastChannel('matrix-shim-peerjs-backend');

  receiver = new BroadcastChannel('matrix-shim-peerjs-frontend');

  peerId?: string;

  transports: PeerjsTransport[] = [];

  openHandlers: ((peerId: string) => unknown)[] = [];

  closeHandlers: ((peerId: string) => unknown)[] = [];

  connectHandlers: ConnectHandler[] = [];

  constructor() {
    // Make sure the client sends us the peerOpened event.
    this.sender.postMessage({ type: 'getPeerId' } as PeerjsBackendMessage);

    this.receiver.addEventListener('message', (event) => {
      // eslint-disable-next-line prefer-destructuring
      const data: PeerjsFrontendMessage = event.data;

      if (data.type === 'incomingConnected') {
        PeerjsTransport.accept(data).then((transport) => {
          this.transports.push(transport);

          for (const handler of this.connectHandlers) {
            handler(transport);
          }
        });
      } else if (data.type === 'peerOpened') {
        if (data.peerId !== this.peerId) {
          this.peerId = data.peerId;
          for (const handler of this.openHandlers) {
            handler(data.peerId);
          }
        }
      } else if (data.type === 'peerClosed') {
        for (const handler of this.closeHandlers) {
          handler(data.peerId);
        }
        this.peerId = undefined;
      }
    });
  }

  async connect(remotePeerId: string): Promise<PeerjsTransport> {
    const transport = await PeerjsTransport.connect(remotePeerId);
    this.transports.push(transport);
    return transport;
  }
}
