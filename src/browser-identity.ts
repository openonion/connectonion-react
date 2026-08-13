/**
 * Browser-owned ConnectOnion identity.
 *
 * The private Ed25519 key is imported as a non-extractable WebCrypto key and
 * persisted through IndexedDB's structured-clone support.  Raw private bytes
 * exist only while creating, importing, or migrating an identity; they are
 * never written back to Web Storage.
 */
import * as bip39 from 'bip39';
import nacl from 'tweetnacl';

const DATABASE_NAME = 'connectonion-browser-identity';
const DATABASE_VERSION = 1;
const OBJECT_STORE = 'identities';
const IDENTITY_ID = 'default';
const LEGACY_STORAGE_KEY = 'connectonion_keys';
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const IDENTITY_PROBE = 'connectonion-browser-identity-v1';

export interface MessageSigner {
  readonly address: string;
  sign(message: string): Promise<string> | string;
}

export interface BrowserIdentity extends MessageSigner {
  readonly shortAddress: string;
  readonly publicKey: Uint8Array;
}

export type BrowserRecoverySecret =
  | { readonly kind: 'mnemonic'; readonly value: string }
  | { readonly kind: 'private-key'; readonly value: string };

export interface BrowserIdentityInitialization {
  readonly identity: BrowserIdentity;
  readonly source: 'loaded' | 'created' | 'migrated' | 'imported';
  /** Returned once for a new or migrated identity; never persisted by this API. */
  readonly recovery?: BrowserRecoverySecret;
}

export class BrowserIdentityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserIdentityUnavailableError';
  }
}

export class BrowserIdentityCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserIdentityCorruptError';
  }
}

interface StoredBrowserIdentity {
  readonly id: typeof IDENTITY_ID;
  readonly version: 1;
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly privateKey: CryptoKey;
}

interface BrowserIdentityStore {
  get(): Promise<unknown | null>;
  add(record: StoredBrowserIdentity): Promise<boolean>;
  put(record: unknown): Promise<void>;
  delete(): Promise<void>;
}

interface LegacyStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

interface BrowserIdentityRuntime {
  readonly crypto: Crypto;
  readonly store: BrowserIdentityStore;
  readonly legacyStorage: LegacyStorage | null;
}

interface PreparedIdentity {
  readonly record: StoredBrowserIdentity;
  readonly recovery?: BrowserRecoverySecret;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(value: string, label: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    throw new BrowserIdentityCorruptError(`Invalid ${label}`);
  }
  const pairs = value.match(/.{2}/g);
  if (!pairs) throw new BrowserIdentityCorruptError(`Invalid ${label}`);
  return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function privateSeedFromMnemonic(mnemonic: string): Uint8Array {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(normalized)) {
    throw new BrowserIdentityCorruptError('Invalid BIP39 recovery phrase');
  }
  const expanded = bip39.mnemonicToSeedSync(normalized);
  const seed = new Uint8Array(expanded.slice(0, 32));
  expanded.fill(0);
  return seed;
}

function rawPrivateSeed(input: string): Uint8Array {
  const normalized = input.trim().toLowerCase().replace(/^0x/, '');
  if (normalized.length !== 64 && normalized.length !== 128) {
    throw new BrowserIdentityCorruptError(
      'Private key recovery requires 32-byte seed or 64-byte Ed25519 secret key hex',
    );
  }
  const bytes = hexToBytes(normalized, 'private key');
  const seed = bytes.slice(0, 32);
  try {
    if (bytes.length === 64) {
      const derived = nacl.sign.keyPair.fromSeed(seed).secretKey;
      try {
        if (bytesToHex(derived) !== bytesToHex(bytes)) {
          throw new BrowserIdentityCorruptError('Private key does not contain a matching public key');
        }
      } finally {
        derived.fill(0);
      }
    }
    return seed;
  } finally {
    bytes.fill(0);
  }
}

function seedFromRecovery(input: string): Uint8Array {
  const normalized = input.trim().toLowerCase();
  if (normalized.includes(' ')) return privateSeedFromMnemonic(normalized);
  return rawPrivateSeed(normalized);
}

async function recordFromSeed(
  seed: Uint8Array,
  cryptoProvider: Crypto,
): Promise<StoredBrowserIdentity> {
  if (seed.byteLength !== 32) {
    throw new BrowserIdentityCorruptError('Ed25519 identity seed must be 32 bytes');
  }
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
  pkcs8.set(ED25519_PKCS8_PREFIX);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);

  let privateKey: CryptoKey;
  try {
    privateKey = await cryptoProvider.subtle.importKey(
      'pkcs8',
      exactArrayBuffer(pkcs8),
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
  } catch (cause) {
    throw new BrowserIdentityUnavailableError(
      `This browser cannot import a non-extractable Ed25519 key: ${String(cause)}`,
    );
  } finally {
    seed.fill(0);
    pkcs8.fill(0);
    keyPair.secretKey.fill(0);
  }

  return {
    id: IDENTITY_ID,
    version: 1,
    address: `0x${bytesToHex(keyPair.publicKey)}`,
    publicKey: new Uint8Array(keyPair.publicKey),
    privateKey,
  };
}

function isCryptoKeyLike(value: unknown): value is CryptoKey {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CryptoKey>;
  return candidate.type === 'private'
    && candidate.extractable === false
    && typeof candidate.algorithm === 'object'
    && candidate.algorithm !== null
    && (candidate.algorithm as KeyAlgorithm).name === 'Ed25519'
    && Array.isArray(candidate.usages)
    && candidate.usages.length === 1
    && candidate.usages[0] === 'sign';
}

async function identityFromRecord(
  value: unknown,
  cryptoProvider: Crypto,
): Promise<BrowserIdentity> {
  if (typeof value !== 'object' || value === null) {
    throw new BrowserIdentityCorruptError('Stored browser identity is not an object');
  }
  const record = value as Partial<StoredBrowserIdentity>;
  if (
    record.id !== IDENTITY_ID
    || record.version !== 1
    || !(record.publicKey instanceof Uint8Array)
    || record.publicKey.byteLength !== 32
    || !isCryptoKeyLike(record.privateKey)
  ) {
    throw new BrowserIdentityCorruptError('Stored browser identity has an invalid shape');
  }

  const publicKey = new Uint8Array(record.publicKey);
  const address = `0x${bytesToHex(publicKey)}`;
  if (record.address !== address) {
    throw new BrowserIdentityCorruptError('Stored browser identity address does not match its public key');
  }

  const probe = new TextEncoder().encode(IDENTITY_PROBE);
  let probeSignature: ArrayBuffer;
  try {
    probeSignature = await cryptoProvider.subtle.sign(
      { name: 'Ed25519' },
      record.privateKey,
      exactArrayBuffer(probe),
    );
  } catch (cause) {
    throw new BrowserIdentityCorruptError(`Stored browser identity cannot sign: ${String(cause)}`);
  }
  if (!nacl.sign.detached.verify(probe, new Uint8Array(probeSignature), publicKey)) {
    throw new BrowserIdentityCorruptError('Stored browser identity private key does not match its address');
  }

  const privateKey = record.privateKey;
  return Object.freeze({
    address,
    shortAddress: shortAddress(address),
    publicKey,
    async sign(message: string): Promise<string> {
      const bytes = new TextEncoder().encode(message);
      const signature = await cryptoProvider.subtle.sign(
        { name: 'Ed25519' },
        privateKey,
        exactArrayBuffer(bytes),
      );
      return bytesToHex(new Uint8Array(signature));
    },
  });
}

function parseLegacyIdentity(value: string): { seed: Uint8Array; recovery: BrowserRecoverySecret } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BrowserIdentityCorruptError('Legacy browser identity is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BrowserIdentityCorruptError('Legacy browser identity has an invalid shape');
  }
  const legacy = parsed as Record<string, unknown>;
  if (
    typeof legacy.address !== 'string'
    || typeof legacy.publicKey !== 'string'
    || typeof legacy.privateKey !== 'string'
  ) {
    throw new BrowserIdentityCorruptError('Legacy browser identity is missing key fields');
  }

  const seed = rawPrivateSeed(legacy.privateKey);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  let seedReturned = false;
  try {
    const publicKeyHex = bytesToHex(keyPair.publicKey);
    if (legacy.publicKey.toLowerCase() !== publicKeyHex || legacy.address.toLowerCase() !== `0x${publicKeyHex}`) {
      throw new BrowserIdentityCorruptError('Legacy browser identity key fields do not agree');
    }

    if (typeof legacy.mnemonic === 'string' && legacy.mnemonic.trim()) {
      const mnemonic = legacy.mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
      const mnemonicSeed = privateSeedFromMnemonic(mnemonic);
      try {
        if (bytesToHex(mnemonicSeed) !== bytesToHex(seed)) {
          throw new BrowserIdentityCorruptError('Legacy recovery phrase does not match the stored identity');
        }
      } finally {
        mnemonicSeed.fill(0);
      }
      seedReturned = true;
      return { seed, recovery: { kind: 'mnemonic', value: mnemonic } };
    }

    seedReturned = true;
    return {
      seed,
      recovery: { kind: 'private-key', value: bytesToHex(keyPair.secretKey) },
    };
  } finally {
    keyPair.secretKey.fill(0);
    if (!seedReturned) seed.fill(0);
  }
}

function readLegacyIdentity(storage: LegacyStorage | null): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(LEGACY_STORAGE_KEY);
  } catch (cause) {
    throw new BrowserIdentityUnavailableError(
      `Cannot inspect legacy browser identity storage; refusing to create a replacement identity: ${String(cause)}`,
    );
  }
}

function removeLegacyIdentity(storage: LegacyStorage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(LEGACY_STORAGE_KEY);
  } catch (cause) {
    throw new BrowserIdentityUnavailableError(
      `Secure identity was verified but the legacy private-key record could not be removed: ${String(cause)}`,
    );
  }
}

function openDatabase(indexedDBProvider: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDBProvider.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OBJECT_STORE)) {
        database.createObjectStore(OBJECT_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open identity database'));
    request.onblocked = () => reject(new Error('Identity database upgrade is blocked by another tab'));
  });
}

function indexedDBStore(indexedDBProvider: IDBFactory): BrowserIdentityStore {
  return {
    async get(): Promise<unknown | null> {
      const database = await openDatabase(indexedDBProvider);
      try {
        return await new Promise((resolve, reject) => {
          const transaction = database.transaction(OBJECT_STORE, 'readonly');
          const request = transaction.objectStore(OBJECT_STORE).get(IDENTITY_ID);
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => reject(request.error ?? new Error('Could not read browser identity'));
          transaction.onabort = () => reject(transaction.error ?? new Error('Identity read aborted'));
        });
      } finally {
        database.close();
      }
    },

    async add(record: StoredBrowserIdentity): Promise<boolean> {
      const database = await openDatabase(indexedDBProvider);
      try {
        return await new Promise((resolve, reject) => {
          const transaction = database.transaction(OBJECT_STORE, 'readwrite');
          const request = transaction.objectStore(OBJECT_STORE).add(record);
          let inserted = true;
          request.onerror = (event) => {
            if (request.error?.name === 'ConstraintError') {
              inserted = false;
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            reject(request.error ?? new Error('Could not persist browser identity'));
          };
          transaction.oncomplete = () => resolve(inserted);
          transaction.onerror = () => reject(transaction.error ?? new Error('Identity write failed'));
          transaction.onabort = () => reject(transaction.error ?? new Error('Identity write aborted'));
        });
      } finally {
        database.close();
      }
    },

    async put(record: unknown): Promise<void> {
      const database = await openDatabase(indexedDBProvider);
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(OBJECT_STORE, 'readwrite');
          transaction.objectStore(OBJECT_STORE).put(record);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error ?? new Error('Identity write failed'));
          transaction.onabort = () => reject(transaction.error ?? new Error('Identity write aborted'));
        });
      } finally {
        database.close();
      }
    },

    async delete(): Promise<void> {
      const database = await openDatabase(indexedDBProvider);
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(OBJECT_STORE, 'readwrite');
          transaction.objectStore(OBJECT_STORE).delete(IDENTITY_ID);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error ?? new Error('Identity delete failed'));
          transaction.onabort = () => reject(transaction.error ?? new Error('Identity delete aborted'));
        });
      } finally {
        database.close();
      }
    },
  };
}

function browserRuntime(): BrowserIdentityRuntime {
  const cryptoProvider = globalThis.crypto;
  const indexedDBProvider = globalThis.indexedDB;
  if (!cryptoProvider?.subtle) {
    throw new BrowserIdentityUnavailableError('Secure browser identity requires Web Crypto');
  }
  if (!indexedDBProvider) {
    throw new BrowserIdentityUnavailableError('Secure browser identity requires IndexedDB');
  }
  let legacyStorage: LegacyStorage | null = null;
  try {
    legacyStorage = globalThis.localStorage ?? null;
  } catch (cause) {
    throw new BrowserIdentityUnavailableError(
      `Cannot inspect legacy browser identity storage; refusing to create a replacement identity: ${String(cause)}`,
    );
  }
  return { crypto: cryptoProvider, store: indexedDBStore(indexedDBProvider), legacyStorage };
}

/** @internal Exported only so deterministic unit tests can inject an in-memory store. */
export function createBrowserIdentityService(runtime: BrowserIdentityRuntime) {
  let cachedIdentity: BrowserIdentity | null = null;
  let inFlightInitialization: Promise<BrowserIdentityInitialization> | null = null;
  let inFlightReplacement: Promise<BrowserIdentityInitialization> | null = null;

  async function verifiedStoredIdentity(): Promise<BrowserIdentity | null> {
    const stored = await runtime.store.get();
    return stored === null ? null : identityFromRecord(stored, runtime.crypto);
  }

  async function verifyWrite(expectedAddress: string): Promise<BrowserIdentity> {
    const identity = await verifiedStoredIdentity();
    if (!identity || identity.address !== expectedAddress) {
      throw new BrowserIdentityCorruptError('Persisted browser identity failed write verification');
    }
    return identity;
  }

  async function prepareFromSeed(seed: Uint8Array, recovery?: BrowserRecoverySecret): Promise<PreparedIdentity> {
    return { record: await recordFromSeed(seed, runtime.crypto), recovery };
  }

  async function replaceStoredIdentity(prepared: PreparedIdentity): Promise<BrowserIdentity> {
    const previous = await runtime.store.get();
    await runtime.store.put(prepared.record);
    try {
      const identity = await verifyWrite(prepared.record.address);
      removeLegacyIdentity(runtime.legacyStorage);
      return identity;
    } catch (cause) {
      try {
        if (previous === null) await runtime.store.delete();
        else await runtime.store.put(previous);
      } catch (rollbackCause) {
        throw new BrowserIdentityCorruptError(
          `Browser identity replacement failed and the previous record could not be restored: ${String(rollbackCause)}`,
        );
      }
      throw cause;
    }
  }

  async function initialize(): Promise<BrowserIdentityInitialization> {
    const stored = await verifiedStoredIdentity();
    const legacyValue = readLegacyIdentity(runtime.legacyStorage);
    if (stored) {
      if (legacyValue) {
        const legacy = parseLegacyIdentity(legacyValue);
        const legacyRecord = await recordFromSeed(legacy.seed, runtime.crypto);
        if (legacyRecord.address !== stored.address) {
          throw new BrowserIdentityCorruptError(
            'Secure and legacy browser identities disagree; refusing to discard either identity',
          );
        }
        removeLegacyIdentity(runtime.legacyStorage);
        return { identity: stored, source: 'migrated', recovery: legacy.recovery };
      }
      return { identity: stored, source: 'loaded' };
    }

    if (legacyValue) {
      const legacy = parseLegacyIdentity(legacyValue);
      const prepared = await prepareFromSeed(legacy.seed, legacy.recovery);
      const inserted = await runtime.store.add(prepared.record);
      const identity = await verifyWrite(prepared.record.address);
      if (inserted || identity.address === prepared.record.address) {
        removeLegacyIdentity(runtime.legacyStorage);
      }
      return {
        identity,
        source: inserted ? 'migrated' : 'loaded',
        ...(inserted ? { recovery: prepared.recovery } : {}),
      };
    }

    const mnemonic = bip39.generateMnemonic(128);
    const recovery: BrowserRecoverySecret = { kind: 'mnemonic', value: mnemonic };
    const prepared = await prepareFromSeed(privateSeedFromMnemonic(mnemonic), recovery);
    const inserted = await runtime.store.add(prepared.record);
    const identity = inserted
      ? await verifyWrite(prepared.record.address)
      : await verifiedStoredIdentity();
    if (!identity) {
      throw new BrowserIdentityCorruptError('Concurrent identity creation produced no stored identity');
    }
    return {
      identity,
      source: inserted ? 'created' : 'loaded',
      ...(inserted ? { recovery } : {}),
    };
  }

  function replaceIdentity(
    operation: () => Promise<BrowserIdentityInitialization>,
  ): Promise<BrowserIdentityInitialization> {
    if (inFlightReplacement) {
      return Promise.reject(new BrowserIdentityUnavailableError(
        'A browser identity replacement is already in progress',
      ));
    }
    const attempt = (async () => {
      if (inFlightInitialization) {
        try {
          await inFlightInitialization;
        } catch {
          // An explicit replacement may recover from failed initialization.
        }
      }
      return operation();
    })();
    inFlightReplacement = attempt;
    return attempt.finally(() => {
      if (inFlightReplacement === attempt) inFlightReplacement = null;
    });
  }

  return {
    load: verifiedStoredIdentity,

    initialize(): Promise<BrowserIdentityInitialization> {
      if (inFlightReplacement) {
        return inFlightReplacement.then(({ identity }) => ({ identity, source: 'loaded' }));
      }
      if (cachedIdentity) {
        return Promise.resolve({ identity: cachedIdentity, source: 'loaded' });
      }
      if (inFlightInitialization) {
        return inFlightInitialization.then(({ identity }) => ({ identity, source: 'loaded' }));
      }
      const attempt = initialize();
      inFlightInitialization = attempt;
      return attempt.then(
        (result) => {
          cachedIdentity = result.identity;
          inFlightInitialization = null;
          return result;
        },
        (cause: unknown) => {
          inFlightInitialization = null;
          throw cause;
        },
      );
    },

    create(): Promise<BrowserIdentityInitialization> {
      return replaceIdentity(async () => {
        const mnemonic = bip39.generateMnemonic(128);
        const recovery: BrowserRecoverySecret = { kind: 'mnemonic', value: mnemonic };
        const prepared = await prepareFromSeed(privateSeedFromMnemonic(mnemonic), recovery);
        const identity = await replaceStoredIdentity(prepared);
        cachedIdentity = identity;
        return { identity, source: 'created', recovery };
      });
    },

    import(input: string): Promise<BrowserIdentityInitialization> {
      return replaceIdentity(async () => {
        const seed = seedFromRecovery(input);
        const prepared = await prepareFromSeed(seed);
        const identity = await replaceStoredIdentity(prepared);
        cachedIdentity = identity;
        return { identity, source: 'imported' };
      });
    },
  };
}

let defaultService: ReturnType<typeof createBrowserIdentityService> | null = null;
let pendingRecovery: BrowserRecoverySecret | null = null;

function service(): ReturnType<typeof createBrowserIdentityService> {
  if (!defaultService) defaultService = createBrowserIdentityService(browserRuntime());
  return defaultService;
}

export async function loadBrowserIdentity(): Promise<BrowserIdentity | null> {
  return service().load();
}

export async function initializeBrowserIdentity(): Promise<BrowserIdentityInitialization> {
  return service().initialize();
}

export async function createBrowserIdentity(): Promise<BrowserIdentityInitialization> {
  const initialized = await service().create();
  pendingRecovery = null;
  return initialized;
}

export async function importBrowserIdentity(input: string): Promise<BrowserIdentityInitialization> {
  const initialized = await service().import(input);
  pendingRecovery = null;
  return initialized;
}

/**
 * Claim recovery material created by an internal default-signer initialization.
 * Applications that initialize identity directly receive recovery in that call;
 * this handoff only covers the race where a connection initialized first.
 */
export function claimPendingBrowserRecovery(): BrowserRecoverySecret | null {
  const recovery = pendingRecovery;
  pendingRecovery = null;
  return recovery;
}

/** @internal Default connection initialization must not silently lose recovery. */
export function retainPendingBrowserRecovery(recovery: BrowserRecoverySecret): void {
  if (!pendingRecovery) pendingRecovery = recovery;
}
