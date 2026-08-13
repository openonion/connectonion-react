import * as bip39 from 'bip39';
import nacl from 'tweetnacl';

import {
  BrowserIdentityCorruptError,
  claimPendingBrowserRecovery,
  createBrowserIdentityService,
  importBrowserIdentity,
  retainPendingBrowserRecovery,
} from '../src/browser-identity';

class MemoryIdentityStore {
  record: unknown | null = null;
  failAdd = false;
  corruptNextPut = false;

  async get(): Promise<unknown | null> {
    return this.record;
  }

  async add(record: unknown): Promise<boolean> {
    if (this.failAdd) throw new Error('simulated IndexedDB failure');
    if (this.record !== null) return false;
    this.record = record;
    return true;
  }

  async put(record: unknown): Promise<void> {
    this.record = this.corruptNextPut ? { invalid: true } : record;
    this.corruptNextPut = false;
  }

  async delete(): Promise<void> {
    this.record = null;
  }
}

class MemoryLegacyStorage {
  private values = new Map<string, string>();
  failRead = false;
  failRemove = false;

  getItem(key: string): string | null {
    if (this.failRead) throw new Error('storage read denied');
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    if (this.failRemove) throw new Error('storage removal denied');
    this.values.delete(key);
  }

  seed(value: string): void {
    this.values.set('connectonion_keys', value);
  }
}

function runtime(store = new MemoryIdentityStore(), legacy = new MemoryLegacyStorage()) {
  return { crypto: globalThis.crypto, store, legacyStorage: legacy };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function legacyRecord(mnemonic?: string): { json: string; address: string; secretKey: Uint8Array } {
  const seed = mnemonic
    ? new Uint8Array(bip39.mnemonicToSeedSync(mnemonic).slice(0, 32))
    : new Uint8Array(32).fill(7);
  const keys = nacl.sign.keyPair.fromSeed(seed);
  const address = `0x${bytesToHex(keys.publicKey)}`;
  return {
    address,
    secretKey: keys.secretKey,
    json: JSON.stringify({
      address,
      shortAddress: `${address.slice(0, 6)}...${address.slice(-4)}`,
      publicKey: bytesToHex(keys.publicKey),
      privateKey: bytesToHex(keys.secretKey),
      ...(mnemonic ? { mnemonic } : {}),
    }),
  };
}

describe('secure browser identity', () => {
  test('hands internally-created recovery to exactly one UI claimant', () => {
    const recovery = { kind: 'mnemonic', value: 'one-time words' } as const;
    retainPendingBrowserRecovery(recovery);

    expect(claimPendingBrowserRecovery()).toEqual(recovery);
    expect(claimPendingBrowserRecovery()).toBeNull();
  });

  test('does not discard pending recovery when an explicit replacement fails', async () => {
    const recovery = { kind: 'mnemonic', value: 'still-current recovery' } as const;
    retainPendingBrowserRecovery(recovery);

    await expect(importBrowserIdentity('not valid recovery material')).rejects.toThrow();

    expect(claimPendingBrowserRecovery()).toEqual(recovery);
  });

  test('creates one non-extractable identity and reloads it without recovery material', async () => {
    const shared = runtime();
    const service = createBrowserIdentityService(shared);

    const created = await service.initialize();
    expect(created.source).toBe('created');
    expect(created.recovery?.kind).toBe('mnemonic');
    expect(bip39.validateMnemonic(created.recovery?.value ?? '')).toBe(true);

    const stored = shared.store.record as { privateKey: CryptoKey; publicKey: Uint8Array };
    expect(stored.privateKey.type).toBe('private');
    expect(stored.privateKey.extractable).toBe(false);
    expect(stored.privateKey.algorithm.name).toBe('Ed25519');
    expect(stored.privateKey.usages).toEqual(['sign']);
    await expect(globalThis.crypto.subtle.exportKey('pkcs8', stored.privateKey)).rejects.toThrow();

    const message = 'signed without exporting the private key';
    const signature = await created.identity.sign(message);
    expect(nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      new Uint8Array(signature.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16))),
      created.identity.publicKey,
    )).toBe(true);

    const reloaded = await createBrowserIdentityService(shared).initialize();
    expect(reloaded.source).toBe('loaded');
    expect(reloaded.recovery).toBeUndefined();
    expect(reloaded.identity.address).toBe(created.identity.address);

    const repeated = await service.initialize();
    expect(repeated.source).toBe('loaded');
    expect(repeated.recovery).toBeUndefined();
  });

  test('migrates a legacy mnemonic record to the same address and deletes it only after verification', async () => {
    const mnemonic = bip39.entropyToMnemonic('00000000000000000000000000000000');
    const legacy = new MemoryLegacyStorage();
    const old = legacyRecord(mnemonic);
    legacy.seed(old.json);
    const shared = runtime(new MemoryIdentityStore(), legacy);

    const migrated = await createBrowserIdentityService(shared).initialize();

    expect(migrated.source).toBe('migrated');
    expect(migrated.identity.address).toBe(old.address);
    expect(migrated.recovery).toEqual({ kind: 'mnemonic', value: mnemonic });
    expect(legacy.getItem('connectonion_keys')).toBeNull();

    const message = 'migration-signature-equivalence';
    expect(await migrated.identity.sign(message)).toBe(bytesToHex(
      nacl.sign.detached(new TextEncoder().encode(message), old.secretKey),
    ));
  });

  test('returns a legacy raw private key once when no mnemonic existed', async () => {
    const legacy = new MemoryLegacyStorage();
    const old = legacyRecord();
    legacy.seed(old.json);

    const migrated = await createBrowserIdentityService(runtime(new MemoryIdentityStore(), legacy)).initialize();

    expect(migrated.identity.address).toBe(old.address);
    expect(migrated.recovery).toEqual({
      kind: 'private-key',
      value: bytesToHex(old.secretKey),
    });
    expect(legacy.getItem('connectonion_keys')).toBeNull();
  });

  test('keeps the legacy record when the secure write fails', async () => {
    const legacy = new MemoryLegacyStorage();
    const old = legacyRecord();
    legacy.seed(old.json);
    const store = new MemoryIdentityStore();
    store.failAdd = true;

    await expect(
      createBrowserIdentityService(runtime(store, legacy)).initialize(),
    ).rejects.toThrow('simulated IndexedDB failure');
    expect(legacy.getItem('connectonion_keys')).toBe(old.json);
    expect(store.record).toBeNull();
  });

  test('rejects inconsistent legacy keys without deleting recovery material', async () => {
    const legacy = new MemoryLegacyStorage();
    const old = JSON.parse(legacyRecord().json) as Record<string, string>;
    old.address = `0x${'00'.repeat(32)}`;
    const corrupted = JSON.stringify(old);
    legacy.seed(corrupted);

    await expect(
      createBrowserIdentityService(runtime(new MemoryIdentityStore(), legacy)).initialize(),
    ).rejects.toBeInstanceOf(BrowserIdentityCorruptError);
    expect(legacy.getItem('connectonion_keys')).toBe(corrupted);
  });

  test('does not silently generate a second address when legacy storage cannot be inspected', async () => {
    const legacy = new MemoryLegacyStorage();
    legacy.failRead = true;
    const store = new MemoryIdentityStore();

    await expect(
      createBrowserIdentityService(runtime(store, legacy)).initialize(),
    ).rejects.toThrow('refusing to create a replacement identity');
    expect(store.record).toBeNull();
  });

  test('surfaces a legacy-removal failure after preserving the verified secure copy', async () => {
    const legacy = new MemoryLegacyStorage();
    const old = legacyRecord();
    legacy.seed(old.json);
    legacy.failRemove = true;
    const store = new MemoryIdentityStore();

    await expect(
      createBrowserIdentityService(runtime(store, legacy)).initialize(),
    ).rejects.toThrow('legacy private-key record could not be removed');
    expect(store.record).not.toBeNull();
    legacy.failRemove = false;
    expect(legacy.getItem('connectonion_keys')).toBe(old.json);
  });

  test('returns recovery when a verified migration finishes after a removal retry', async () => {
    const legacy = new MemoryLegacyStorage();
    const old = legacyRecord();
    legacy.seed(old.json);
    legacy.failRemove = true;
    const service = createBrowserIdentityService(runtime(new MemoryIdentityStore(), legacy));

    await expect(service.initialize()).rejects.toThrow(
      'legacy private-key record could not be removed',
    );

    legacy.failRemove = false;
    const migrated = await service.initialize();

    expect(migrated.source).toBe('migrated');
    expect(migrated.identity.address).toBe(old.address);
    expect(migrated.recovery).toEqual({
      kind: 'private-key',
      value: bytesToHex(old.secretKey),
    });
    expect(legacy.getItem('connectonion_keys')).toBeNull();
  });

  test('concurrent creators converge on the one record that won IndexedDB add', async () => {
    const shared = runtime();
    const first = createBrowserIdentityService(shared);
    const second = createBrowserIdentityService(shared);

    const [a, b] = await Promise.all([first.initialize(), second.initialize()]);

    expect(a.identity.address).toBe(b.identity.address);
    expect([a.source, b.source].sort()).toEqual(['created', 'loaded']);
    expect([a.recovery, b.recovery].filter(Boolean)).toHaveLength(1);
  });

  test('imports mnemonic recovery and replaces the persisted identity', async () => {
    const shared = runtime();
    const service = createBrowserIdentityService(shared);
    const before = await service.initialize();
    const mnemonic = bip39.entropyToMnemonic('ffffffffffffffffffffffffffffffff');

    const imported = await service.import(mnemonic);
    const reloaded = await createBrowserIdentityService(shared).initialize();

    expect(imported.source).toBe('imported');
    expect(imported.recovery).toBeUndefined();
    expect(imported.identity.address).not.toBe(before.identity.address);
    expect(reloaded.identity.address).toBe(imported.identity.address);
  });

  test('restores the previous identity when replacement verification fails', async () => {
    const shared = runtime();
    const service = createBrowserIdentityService(shared);
    const before = await service.initialize();
    shared.store.corruptNextPut = true;

    await expect(service.create()).rejects.toBeInstanceOf(BrowserIdentityCorruptError);

    const reloaded = await createBrowserIdentityService(shared).initialize();
    expect(reloaded.identity.address).toBe(before.identity.address);
  });

  test('deletes an unverifiable replacement when no previous identity existed', async () => {
    const shared = runtime();
    shared.store.corruptNextPut = true;

    await expect(
      createBrowserIdentityService(shared).create(),
    ).rejects.toBeInstanceOf(BrowserIdentityCorruptError);

    expect(shared.store.record).toBeNull();
  });

  test('restores the previous identity when legacy cleanup blocks replacement', async () => {
    const legacy = new MemoryLegacyStorage();
    const old = legacyRecord();
    legacy.seed(old.json);
    const shared = runtime(new MemoryIdentityStore(), legacy);
    const service = createBrowserIdentityService(shared);
    const before = await service.initialize();

    legacy.seed(old.json);
    legacy.failRemove = true;
    await expect(service.create()).rejects.toThrow('legacy private-key record could not be removed');

    legacy.failRemove = false;
    const reloaded = await createBrowserIdentityService(shared).initialize();
    expect(reloaded.identity.address).toBe(before.identity.address);
    expect(legacy.getItem('connectonion_keys')).toBeNull();
  });

  test('does not let concurrent replacements return stale recovery material', async () => {
    const service = createBrowserIdentityService(runtime());

    const first = service.create();
    const second = service.create();

    await expect(second).rejects.toThrow('replacement is already in progress');
    const created = await first;
    expect((await service.initialize()).identity.address).toBe(created.identity.address);
  });
});
