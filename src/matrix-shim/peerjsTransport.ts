/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Transport } from '@earthstar/earthstar';
import { IS_ALFIE, IS_BETTY } from '@earthstar/willow';
import { DataConnection } from 'peerjs';
import { FIFO } from '@korkje/fifo';

type SyncRole = Transport['role'];

export class PeerjsTransport implements Transport {
  conn: DataConnection;

  role: SyncRole;

  isClosed = false;

  received = new FIFO<ArrayBuffer>();

  /** Open a new outgoing PeerJS connection. */
  static async connect(conn: DataConnection): Promise<PeerjsTransport> {
    return PeerjsTransport.init(IS_ALFIE as any, conn);
  }

  /** Accept an incoming PeerJS connection. */
  static async accept(conn: DataConnection): Promise<PeerjsTransport> {
    return PeerjsTransport.init(IS_BETTY as any, conn);
  }

  private static async init(role: SyncRole, conn: DataConnection): Promise<PeerjsTransport> {
    const t = new PeerjsTransport(role, conn);

    conn.on('close', () => {
      t.isClosed = true;
    });

    conn.on('data', (data) => {
      t.received.push(data as Uint8Array);
    });

    if (!conn.open) {
      await new Promise((resolve) => {
        conn.on('open', () => {
          resolve(undefined);
        });
      });
    }

    return t;
  }

  constructor(role: SyncRole, connection: DataConnection) {
    this.role = role;
    this.conn = connection;
  }

  async send(bytes: Uint8Array): Promise<void> {
    await this.conn.send(bytes);
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
    this.conn.close();
  }
}
