/* eslint-disable @typescript-eslint/no-explicit-any */
import { DidDocument } from '@atproto/oauth-client';
import * as earthstar from '@earthstar/earthstar';

// eslint-disable-next-line consistent-return
const handleCache: { [did: string]: DidDocument } = {};

/**
 * Resolve a did to it's AtProto handle.
 */
// eslint-disable-next-line consistent-return
export async function resolveDid(did: string): Promise<DidDocument | undefined> {
  if (handleCache[did]) return handleCache[did];
  try {
    const resp = await fetch(`https://plc.directory/${did}`);
    const json = await resp.json();
    return json;
  } catch (_e) {
    // Ignore error
  }
}

export async function resolveDidToHandle(did: string): Promise<string | undefined> {
  const doc = await resolveDid(did);
  return doc?.alsoKnownAs?.[0].split('at://')[1];
}

/** Helper to convert a URL to a pigeon mxc:// url.
 *
 * All this does is base64 encode the URL as the media ID and add it to a pigeon.muni.town server.
 */
export function urlToMxc(url: string) {
  return `mxc://pigeon/${btoa(url)}`;
}

const KEY_SERVICE = 'https://keyserver.pigeon.muni.town';

const keyCache: { [did: string]: earthstar.IdentityTag } = {};

/** Resolve a DID to it's public key. */
export async function resolvePublicKey(did: string): Promise<earthstar.IdentityTag | undefined> {
  if (keyCache[did]) return keyCache[did];

  const didDoc = await resolveDid(did);
  if (!didDoc) return undefined;

  // First try to get the public key from the PDS record.
  const pdsService = (didDoc.service || []).find((x) => x.id === '#atproto_pds');
  if (!pdsService || typeof pdsService.serviceEndpoint !== 'string') return undefined;
  const pdsUrl = new URL(pdsService.serviceEndpoint);
  pdsUrl.pathname = '/xrpc/com.atproto.repo.getRecord';
  pdsUrl.searchParams.set('repo', did);
  pdsUrl.searchParams.set('collection', 'id.pigeon.muni.town');
  pdsUrl.searchParams.set('rkey', 'self');
  let resp = await fetch(pdsUrl);

  const j1: { error: string } | { value: any } = await resp.json();
  if ('value' in j1) {
    if (j1.value.publicKey && typeof j1.value.publicKey === 'string') {
      keyCache[did] = j1.value.publicKey;
      return j1.value.publicKey;
    }
  }

  // If we don't have a public key from the PDS directly, use the one from the key service.
  resp = await fetch(
    `${KEY_SERVICE}/xrpc/public.key.pigeon.muni.town?did=${encodeURIComponent(did)}`
  );
  const j2 = await resp.json();
  keyCache[did] = j2.publicKey;
  return j2.publicKey;
}
