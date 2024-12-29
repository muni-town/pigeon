/* eslint-disable @typescript-eslint/no-explicit-any */
import { Agent } from '@atproto/api';
import { verifyJwt } from '@atproto/xrpc-server';
import { IdResolver } from '@atproto/identity';

const handshakeXrpcMethod = 'town.muni.pigeon.handshake';

export class DidHandshake {
  agent: Agent;

  idResolver: IdResolver;

  localDid: string;

  remoteDid: string;

  #challenge: string | undefined;

  constructor(agent: Agent, idResolver: IdResolver, localDid: string, remoteDid: string) {
    this.agent = agent;
    this.idResolver = idResolver;
    this.localDid = localDid;
    this.remoteDid = remoteDid;
  }

  /** Create a challenge to send to the remote. */
  createChallenge(): string {
    if (this.#challenge) throw new Error('Challenge already created');
    this.#challenge = crypto.randomUUID();

    return this.#challenge;
  }

  /** Validate a challenge response sent back to us from the remote. */
  async validateChallengeResponse(jwt: string) {
    const getSigningKey = async (did: string, forceRefresh: boolean): Promise<string> => {
      const atprotoData = await this.idResolver.did.resolveAtprotoData(did, forceRefresh);
      return atprotoData.signingKey;
    };
    await verifyJwt(jwt, `${this.localDid}-${this.#challenge}`, handshakeXrpcMethod, getSigningKey);
  }

  /** Create a response to the remote's challenge. */
  async respondToChallenge(challenge: string): Promise<string> {
    const token = await this.agent.com.atproto.server.getServiceAuth({
      aud: `${this.remoteDid}-${challenge}`,
      lxm: handshakeXrpcMethod,
    });
    return token.data.token;
  }
}
