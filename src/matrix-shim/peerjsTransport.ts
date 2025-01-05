/* eslint-disable no-console */
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
type ConnCloseHandler = (ev: { peerId: string; connectionId: string }) => unknown;
type PeerOpenCloseHandler = (peerId: string) => unknown;

export class ConnectionManager {
  sender = new BroadcastChannel('matrix-shim-peerjs-backend');

  receiver = new BroadcastChannel('matrix-shim-peerjs-frontend');

  peerId?: string;

  transports: PeerjsTransport[] = [];

  peerOpenHandlers: PeerOpenCloseHandler[] = [];

  peerCloseHandlers: PeerOpenCloseHandler[] = [];

  peerConnectHandlers: ConnectHandler[] = [];

  connCloseHandlers: ConnCloseHandler[] = [];

  constructor(initialHandlers: {
    peerOpenHandlers?: PeerOpenCloseHandler[];
    peerCloseHandlers?: PeerOpenCloseHandler[];
    peerConnectHandlers?: ConnectHandler[];
    connCloseHandlers?: ConnCloseHandler[];
  }) {
    if (initialHandlers.peerCloseHandlers)
      this.peerCloseHandlers = initialHandlers.peerCloseHandlers;
    if (initialHandlers.peerOpenHandlers) this.peerOpenHandlers = initialHandlers.peerOpenHandlers;
    if (initialHandlers.peerConnectHandlers)
      this.peerConnectHandlers = initialHandlers.peerConnectHandlers;

    // Make sure the client sends us the peerOpened event.
    this.sender.postMessage({ type: 'getPeerId' } as PeerjsBackendMessage);

    this.receiver.addEventListener('message', (event) => {
      // eslint-disable-next-line prefer-destructuring
      const message: PeerjsFrontendMessage = event.data;
      if (message.type !== 'connData') {
        console.info('PeerJS:', message);
      }

      // Add incoming connections to transport list
      if (message.type === 'incomingConnected') {
        PeerjsTransport.accept(message).then((transport) => {
          this.transports.push(transport);

          for (const handler of this.peerConnectHandlers) {
            handler(transport);
          }
        });

        // Set current peer ID
      } else if (message.type === 'peerOpened') {
        if (message.peerId !== this.peerId) {
          this.peerId = message.peerId;
          for (const handler of this.peerOpenHandlers) {
            handler(message.peerId);
          }
        }

        // Prune transports from closed peer
      } else if (message.type === 'peerClosed') {
        for (const handler of this.peerCloseHandlers) {
          handler(message.peerId);
        }
        this.peerId = undefined;
        this.transports = this.transports.filter(
          (transport) => transport.peerId === message.peerId
        );

        // Prune closed connections
      } else if (message.type === 'connClosed') {
        for (const handler of this.connCloseHandlers) {
          handler({ peerId: message.peerId, connectionId: message.connectionId });
        }
        this.transports = this.transports.filter(
          (transport) => transport.connId !== message.connectionId
        );
      }
    });
  }

  pruneDisconnectedTransports() {
    this.transports = this.transports.filter((x) => x.isClosed);
    console.log('transports', this.transports);
  }

  async connect(remotePeerId: string): Promise<PeerjsTransport> {
    const existingTransport = this.transports.find((x) => x.remotePeerId === remotePeerId);
    if (existingTransport) return existingTransport;

    console.info('Trying to connect to remote peer:', remotePeerId);
    const transport = await PeerjsTransport.connect(remotePeerId);
    console.info('Connection to peer opened:', remotePeerId);
    this.transports.push(transport);
    return transport;
  }
}
