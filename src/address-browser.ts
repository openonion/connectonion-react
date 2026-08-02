/**
 * @purpose Browser-only Ed25519 key generation and signing using tweetnacl (lightweight alternative to Node.js crypto module)
 * @llm-note
 *   Dependencies: imports from [tweetnacl (npm package)] | imported by [oo-chat/components/chat/use-agent-stream.ts, oo-chat/app/api/chat/route.ts (via dist)] | tested by manual browser testing
 *   Data flow: generateBrowser() → nacl.sign.keyPair() → converts to hex address → returns AddressData | signBrowser(addressData, message) → TextEncoder → nacl.sign.detached() → returns hex signature | saveBrowser(keys) → JSON.stringify → localStorage.setItem | loadBrowser() → localStorage.getItem → JSON.parse → hex to Uint8Array
 *   State/Effects: reads/writes localStorage key 'connectonion_keys' | uses window.localStorage directly | mutates browser storage | keys persist across browser sessions (until localStorage cleared)
 *   Integration: exposes generateBrowser(), saveBrowser(keys), loadBrowser(), signBrowser(addressData, message), createSignedPayloadBrowser(addressData, prompt, toAddress), AddressData type | browser-only (checks typeof window) | canonical JSON with sorted keys for consistent signatures
 *   Performance: tweetnacl Ed25519 (faster than WASM alternatives) | localStorage persistence (synchronous) | hex string encoding/decoding | ~1ms for key generation, <1ms for signing
 *   Errors: returns early if typeof window === 'undefined' | throws JSON.parse errors on invalid localStorage data | no key validation on signBrowser()
 *
 * Architecture:
 *   - Browser-only alternative to address.ts (which uses Node.js crypto)
 *   - Uses tweetnacl instead of Node.js crypto module (smaller bundle, browser-native)
 *   - localStorage for persistence instead of filesystem
 *   - Canonical JSON for signature consistency (sorted keys prevent signature drift)
 *
 * Browser Ed25519 Authentication Flow:
 *   1. First Visit (no keys):
 *      loadBrowser() → returns null
 *      → generateBrowser() creates new keypair
 *      → saveBrowser() stores to localStorage['connectonion_keys']
 *
 *   2. Subsequent Visits:
 *      loadBrowser() → retrieves from localStorage
 *      → returns same AddressData (persistent identity)
 *
 *   3. Signing Messages:
 *      createSignedPayloadBrowser(keys, prompt, agentAddress)
 *      → creates payload: {prompt, to, timestamp}
 *      → canonicalJSON() sorts keys for consistent message
 *      → signBrowser() creates Ed25519 signature
 *      → returns {payload, from: publicKey, signature}
 *
 *   4. Agent Verification (remote):
 *      Agent receives {payload, from, signature}
 *      → Extracts public key from 'from' address
 *      → Verifies signature matches canonical payload
 *      → If valid: process request
 *      → If invalid: reject (tampered or wrong sender)
 *
 * Why Ed25519:
 *   - Fast: <1ms signing, verification
 *   - Small: 32-byte public keys, 64-byte signatures
 *   - Secure: Industry-standard elliptic curve cryptography
 *   - Deterministic: Same message + key = same signature
 *
 * Storage Format (localStorage):
 *   {
 *     "address": "0x<64 hex chars>",           // Public key as hex (agent identifier)
 *     "shortAddress": "0x<6 chars>...<4>",     // Display-friendly shortened version
 *     "publicKey": "<hex string>",             // 32 bytes as hex
 *     "privateKey": "<hex string>"             // 64 bytes (seed + pubkey) as hex
 *   }
 *
 * Related Files:
 *   - src/address.ts: Node.js version (uses crypto module, saves to filesystem)
 *   - oo-chat/components/chat/use-agent-stream.ts: Uses this for WebSocket auth
 *   - oo-chat/app/api/chat/route.ts: Server uses address.ts, but imports this via dist for types
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nacl = require('tweetnacl');

// Browser globals type declarations
declare const window: {
  localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
};

export interface AddressData {
  address: string;
  shortAddress: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Canonical JSON with sorted keys for consistent signatures.
 */
function canonicalJSON(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedObj[key] = obj[key];
  }
  return JSON.stringify(sortedObj);
}

/**
 * Generate Ed25519 key pair for browser.
 */
export function generateBrowser(): AddressData {
  const keyPair = nacl.sign.keyPair();

  const address = '0x' + Array.from(keyPair.publicKey as Uint8Array).map(b => (b as number).toString(16).padStart(2, '0')).join('');
  const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;

  return {
    address,
    shortAddress,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.secretKey,  // 64 bytes: seed + public key
  };
}

/**
 * Save keys to browser localStorage.
 */
export function saveBrowser(keys: AddressData): void {
  if (typeof window === 'undefined') return;

  const data = {
    address: keys.address,
    shortAddress: keys.shortAddress,
    publicKey: Array.from(keys.publicKey).map(b => b.toString(16).padStart(2, '0')).join(''),
    privateKey: Array.from(keys.privateKey).map(b => b.toString(16).padStart(2, '0')).join(''),
  };

  window.localStorage.setItem('connectonion_keys', JSON.stringify(data));
}

/**
 * Load keys from browser localStorage.
 */
export function loadBrowser(): AddressData | null {
  if (typeof window === 'undefined') return null;

  const stored = window.localStorage.getItem('connectonion_keys');
  if (!stored) {
    return null;
  }

  try {
    const data = JSON.parse(stored) as {
      address: string;
      shortAddress: string;
      publicKey: string;
      privateKey: string;
    };

    // Convert hex strings back to Uint8Array
    const publicKey = new Uint8Array(data.publicKey.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const privateKey = new Uint8Array(data.privateKey.match(/.{2}/g)!.map(b => parseInt(b, 16)));

    return {
      address: data.address,
      shortAddress: data.shortAddress,
      publicKey,
      privateKey,
    };
  } catch {
    return null;
  }
}

/**
 * Sign a message using tweetnacl.
 */
export function signBrowser(addressData: AddressData, message: string): string {
  const msgBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(msgBytes, addressData.privateKey);

  return Array.from(signature as Uint8Array).map(b => (b as number).toString(16).padStart(2, '0')).join('');
}

/**
 * Create a signed request payload for browser.
 */
export function createSignedPayloadBrowser(
  addressData: AddressData,
  prompt: string,
  toAddress: string
): {
  payload: { prompt: string; to: string; timestamp: number };
  from: string;
  signature: string;
} {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    prompt,
    to: toAddress,
    timestamp,
  };

  const canonicalMessage = canonicalJSON(payload);
  const signature = signBrowser(addressData, canonicalMessage);

  return {
    payload,
    from: addressData.address,
    signature,
  };
}
