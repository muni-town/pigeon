/* eslint-disable no-console */
import Peer, { DataConnection } from 'peerjs';

export type PeerjsFrontendMessage =
  | { type: 'peerOpened'; peerId: string }
  | { type: 'peerClosed'; peerId: string }
  | { type: 'connOpened'; peerId: string; connectionId: string; transportId: string }
  | { type: 'connData'; peerId: string; connectionId: string; data: unknown }
  | { type: 'connClosed'; peerId: string; connectionId: string }
  | { type: 'incomingConnected'; peerId: string; connId: string; remotePeerId: string };

export type PeerjsBackendMessage =
  | { type: 'getPeerId' }
  | {
      type: 'connect';
      transportId: string;
      remotePeerId: string;
    }
  | { type: 'sendData'; peerId: string; connectionId: string; data: unknown }
  | { type: 'closeConn'; peerId: string; connectionId: string };

export class PeerjsFrontendManager {
  peer: Peer;

  connections: { [id: string]: DataConnection } = {};

  sender: BroadcastChannel = new BroadcastChannel('matrix-shim-peerjs-frontend');

  receiver: BroadcastChannel = new BroadcastChannel('matrix-shim-peerjs-backend');

  constructor() {
    this.peer = new Peer();
    this.peer.on('open', (id) => {
      const message: PeerjsFrontendMessage = { type: 'peerOpened', peerId: id };
      console.log('PeerJS:', message);
      this.sender.postMessage(message);
    });

    this.peer.on('disconnected', () => {
      console.error('Peer disconnected.');
    });
    this.peer.on('error', (error) => {
      console.error('Peer error', error);
    });

    // When we receive a connection from outside
    this.peer.on('connection', (conn) => {
      conn.on('open', () => {
        this.addConnectionDataCloseHandlers(conn);

        // Add the connection to the list
        this.connections[conn.connectionId] = conn;

        // And send a connected event to the service worker
        const m: PeerjsFrontendMessage = {
          type: 'incomingConnected',
          peerId: this.peer.id,
          connId: conn.connectionId,
          remotePeerId: conn.peer,
        };
        console.info(m);
        this.sender.postMessage(m);
      });
    });

    // When the peer closes
    this.peer.on('close', () => {
      // Tell the service worker
      const m: PeerjsFrontendMessage = {
        type: 'peerClosed',
        peerId: this.peer.id,
      };
      console.info(m);
      this.sender.postMessage(m);
    });

    // When we receive a message from our service worker
    this.receiver.addEventListener('message', (event) => {
      const message: PeerjsBackendMessage = event.data;

      // If we should connect to another peer
      if (message.type === 'connect') {
        // TODO: support multiple browser tabs being open.
        //
        // Right now all open tabs will try to connect when they receive this message which is not
        // good.

        // Create the connection
        const conn = this.peer.connect(message.remotePeerId, { reliable: true });

        this.connections[conn.connectionId] = conn;

        // When the connection opens
        conn.on('open', () => {
          // Tell the service worker the connection has opened.
          const m: PeerjsFrontendMessage = {
            type: 'connOpened',
            peerId: this.peer.id,
            connectionId: conn.connectionId,
            transportId: message.transportId,
          };
          console.info(m);
          this.sender.postMessage(m);
        });

        this.addConnectionDataCloseHandlers(conn);

        // If the service worker wants us to send data
      } else if (message.type === 'sendData') {
        // Get the connection and send it
        const conn = this.connections[message.connectionId];
        if (conn) {
          conn.send(message.data);
        }
      } else if (message.type === 'getPeerId') {
        // Tell the service worker the connection has opened.
        const m: PeerjsFrontendMessage = {
          type: 'peerOpened',
          peerId: this.peer.id,
        };
        this.sender.postMessage(m);
      }
    });
  }

  addConnectionDataCloseHandlers(conn: DataConnection) {
    conn.on('error', (error) => {
      console.error('Peer connection error', error);
    });
    conn.on('iceStateChanged', (state) => {
      console.log('Connection state change', state);
    });

    // When the connection has data
    conn.on('data', (data) => {
      // Tell the service worker the connection has opened.
      const m: PeerjsFrontendMessage = {
        type: 'connData',
        peerId: this.peer.id,
        connectionId: conn.connectionId,
        data,
      };
      this.sender.postMessage(m);
    });

    // When the connection closees
    conn.on('close', () => {
      console.info('Connection closed', conn.connectionId);
      // Tell the service worker the connection has opened.
      const m: PeerjsFrontendMessage = {
        type: 'connClosed',
        peerId: this.peer.id,
        connectionId: conn.connectionId,
      };
      console.info(m);
      this.sender.postMessage(m);
    });
  }
}
