/**
 * @purpose Agent address/identity management with Ed25519 key generation, signing, and verification (Python address.py parity)
 * @llm-note
 *   Dependencies: imports from [crypto, fs, path (Node.js built-ins, conditional)] | imported by [src/connect/remote-agent.ts, src/index.ts, tests/connect.test.ts, tests/address.test.ts, tests/e2e/signedAgent.test.ts] | tested by [tests/address.test.ts]
 *   Data flow: generate() → creates Ed25519 keypair → exports to raw buffers → returns AddressData{address: 0x..., publicKey, privateKey} | sign(addressData, message) → recreates privateKey from buffer → signs with crypto.sign() → returns hex signature | verify(address, message, signature) → recreates publicKey from address → verifies with crypto.verify() → returns boolean
 *   State/Effects: reads/writes .co/keys/agent.key (Node.js) | reads/writes localStorage connectonion_keys (browser) | conditional require() for Node.js modules | detects environment via globalThis.window check
 *   Integration: exposes generate(), load(coDir), save(), sign(addressData, message), verify(address, message, signature), createSignedPayload(addressData, prompt, toAddress), AddressData type | browser variants: generateBrowser(), loadBrowser(), saveBrowser(), signBrowser() | canonical JSON with sorted keys for consistent signatures
 *   Performance: Ed25519 keypair generation (crypto.generateKeyPairSync) | PKCS#8/SPKI DER encoding for key export | synchronous fs operations | localStorage for browser persistence
 *   Errors: throws if generate() called in browser (requires Node.js crypto) | throws if sign()/verify() called in browser (use signBrowser/verifyBrowser) | returns null if load() finds no keys | returns false on verify() failure
 *
 * Architecture:
 *   - Node.js: crypto module for Ed25519, fs for .co/keys/agent.key persistence
 *   - Browser: tweetnacl for Ed25519, localStorage for key persistence
 *   - Dual exports: regular functions (Node.js) and *Browser functions (browser)
 *   - Canonical JSON: sorted keys for consistent signature verification
 */

// Use dynamic imports for Node.js modules to support browser builds
let crypto: typeof import('crypto') | null = null;
let fs: typeof import('fs') | null = null;
let path: typeof import('path') | null = null;

// Try to load Node.js modules (will fail in browser)
try {
  crypto = require('crypto');
  fs = require('fs');
  path = require('path');
} catch {
  // Browser environment - crypto/fs not available
}

export interface AddressData {
  address: string;
  shortAddress: string;
  publicKey: Buffer | Uint8Array;
  privateKey: Buffer | Uint8Array;
}

/**
 * Check if running in browser environment.
 */
function isBrowser(): boolean {
  return typeof globalThis !== 'undefined' &&
    typeof (globalThis as { window?: unknown }).window !== 'undefined' &&
    typeof (globalThis as { localStorage?: unknown }).localStorage !== 'undefined';
}

// Minimal browser interfaces for Node.js compilation
interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Get localStorage safely (browser only).
 */
function getLocalStorage(): BrowserStorage | null {
  if (isBrowser()) {
    return (globalThis as unknown as { localStorage: BrowserStorage }).localStorage;
  }
  return null;
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
 * Generate a new agent address with Ed25519 keys (Node.js only).
 */
export function generate(): AddressData {
  if (!crypto) {
    throw new Error('generate() requires Node.js environment with crypto module');
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  // Export keys to raw buffers
  const publicKeyBuffer = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const privateKeyBuffer = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);

  const address = '0x' + publicKeyBuffer.toString('hex');
  const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;

  return {
    address,
    shortAddress,
    publicKey: publicKeyBuffer,
    privateKey: privateKeyBuffer,
  };
}

/**
 * Load existing agent keys from .co/keys/ directory (Node.js only).
 */
export function load(coDir: string = '.co'): AddressData | null {
  if (!crypto || !fs || !path) {
    return null;
  }

  const keyFile = path.join(coDir, 'keys', 'agent.key');

  if (!fs.existsSync(keyFile)) {
    return null;
  }

  try {
    const privateKeyBuffer = fs.readFileSync(keyFile);

    // Recreate key objects from raw bytes
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS#8 Ed25519 prefix
        privateKeyBuffer,
      ]),
      format: 'der',
      type: 'pkcs8',
    });

    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyBuffer = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);

    const address = '0x' + publicKeyBuffer.toString('hex');
    const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;

    return {
      address,
      shortAddress,
      publicKey: publicKeyBuffer,
      privateKey: privateKeyBuffer,
    };
  } catch {
    return null;
  }
}

/**
 * Save keys to browser localStorage.
 */
export function saveBrowser(keys: AddressData): void {
  const storage = getLocalStorage();
  if (!storage) {
    throw new Error('saveBrowser() requires browser environment');
  }

  // Convert Uint8Array to hex string (browser-safe, no Buffer dependency)
  const data = {
    address: keys.address,
    shortAddress: keys.shortAddress,
    publicKey: Array.from(keys.publicKey).map(b => b.toString(16).padStart(2, '0')).join(''),
    privateKey: Array.from(keys.privateKey).map(b => b.toString(16).padStart(2, '0')).join(''),
  };

  storage.setItem('connectonion_keys', JSON.stringify(data));
}

/**
 * Load keys from browser localStorage.
 */
export function loadBrowser(): AddressData | null {
  const storage = getLocalStorage();
  if (!storage) {
    return null;
  }

  const stored = storage.getItem('connectonion_keys');
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

    // Convert hex strings to Uint8Array (browser-safe, no Buffer dependency)
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
 * Generate keys in browser using tweetnacl Ed25519.
 */
export function generateBrowser(): AddressData {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nacl = require('tweetnacl');

  // Generate Ed25519 key pair
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
 * Sign a message in browser using tweetnacl.
 */
export function signBrowser(addressData: AddressData, message: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nacl = require('tweetnacl');

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

/**
 * Sign a message with the agent's private key (Node.js only).
 */
export function sign(addressData: AddressData, message: string | Buffer): string {
  if (!crypto) {
    throw new Error('sign() requires Node.js environment with crypto module');
  }

  const msgBuffer = typeof message === 'string' ? Buffer.from(message) : message;

  // Recreate private key object
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(addressData.privateKey),
    ]),
    format: 'der',
    type: 'pkcs8',
  });

  const signature = crypto.sign(null, msgBuffer, privateKey);
  return signature.toString('hex');
}

/**
 * Verify a signature using an agent's address (public key).
 */
export function verify(address: string, message: string | Buffer, signature: string): boolean {
  if (!crypto) {
    return false;
  }

  try {
    if (!address.startsWith('0x') || address.length !== 66) {
      return false;
    }

    const publicKeyBuffer = Buffer.from(address.slice(2), 'hex');
    const msgBuffer = typeof message === 'string' ? Buffer.from(message) : message;
    const sigBuffer = Buffer.from(signature, 'hex');

    // Recreate public key object
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), // SPKI Ed25519 prefix
        publicKeyBuffer,
      ]),
      format: 'der',
      type: 'spki',
    });

    return crypto.verify(null, msgBuffer, publicKey, sigBuffer);
  } catch {
    return false;
  }
}

/**
 * Create a signed request payload for agent requests.
 * Always sign when keys are available (works with all trust levels).
 *
 * Uses canonical JSON (sorted keys) for consistent signatures.
 */
export function createSignedPayload(
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

  // Use canonical JSON with sorted keys for consistent signatures
  const canonicalMessage = canonicalJSON(payload);
  const signature = sign(addressData, canonicalMessage);

  return {
    payload,
    from: addressData.address,
    signature,
  };
}
