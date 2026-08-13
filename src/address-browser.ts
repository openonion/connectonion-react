/**
 * Ephemeral raw Ed25519 helpers for compatibility and deterministic protocol
 * tests. Persistent browser identities live in browser-identity.ts, where the
 * private key is a non-extractable CryptoKey stored in IndexedDB.
 */
import nacl from 'tweetnacl';

export interface AddressData {
  address: string;
  shortAddress: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalJSON(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) sortedObj[key] = obj[key];
  return JSON.stringify(sortedObj);
}

/** Generate an in-memory Ed25519 key pair. This function does not persist it. */
export function generateBrowser(): AddressData {
  const keyPair = nacl.sign.keyPair();
  const address = `0x${bytesToHex(keyPair.publicKey)}`;
  return {
    address,
    shortAddress: `${address.slice(0, 6)}...${address.slice(-4)}`,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.secretKey,
  };
}

/** Sign with an explicitly supplied in-memory raw key pair. */
export function signBrowser(addressData: AddressData, message: string): string {
  const signature = nacl.sign.detached(
    new TextEncoder().encode(message),
    addressData.privateKey,
  );
  return bytesToHex(signature);
}

/** Create a signed request with an explicitly supplied in-memory raw key pair. */
export function createSignedPayloadBrowser(
  addressData: AddressData,
  prompt: string,
  toAddress: string,
): {
  payload: { prompt: string; to: string; timestamp: number };
  from: string;
  signature: string;
} {
  const payload = {
    prompt,
    to: toAddress,
    timestamp: Math.floor(Date.now() / 1000),
  };
  return {
    payload,
    from: addressData.address,
    signature: signBrowser(addressData, canonicalJSON(payload)),
  };
}
