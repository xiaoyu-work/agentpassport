import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  addDeviceSlot,
  addPassphraseSlot,
  addRecoverySlot,
  createKeyring,
  deviceSlotId,
  hasSlot,
  keyIdFor,
  mergeKeyrings,
  openEnvelope,
  sealEnvelope,
  unlockWithDeviceKey,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  UnlockError,
  type EncryptedEnvelope,
  type Keyring,
} from '@agentpass/crypto';
import { MemoryRecordSchema, type MemoryRecord } from '@agentpass/memory';
import { parseProfile, type UniversalProfile } from '@agentpass/profile';
import type { Revision } from '@agentpass/sync';
import { ensureDeviceKey, openDeviceKeyStore, type DeviceKeyStore } from './device-key.js';

export interface Session {
  userId: string;
  email?: string;
  /** Issued by the sync server. Absent in fully local mode. */
  token?: string;
  serverUrl?: string;
  device: string;
  deviceId: string;
  createdAt: string;
}

/**
 * What the encrypted envelope actually contains.
 *
 * Profile and memories travel together because they are worthless apart: restoring an
 * agent that has the user's MCP servers but none of their long-term memory is exactly the
 * "it doesn't know me" experience this product exists to remove.
 */
export interface VaultBundle {
  profile: UniversalProfile;
  memories: MemoryRecord[];
}

interface VaultFile {
  v: 2;
  session: Session;
  keyring: Keyring;
  profile: EncryptedEnvelope;
  /** Last state successfully synced, used as the merge ancestor. */
  base?: EncryptedEnvelope;
  history: Revision[];
}

export interface StoreOptions {
  home: string;
  device: string;
  deviceId: string;
}

export interface UnlockResult {
  dataKey: Buffer;
  /** How the vault was opened, so the UI can explain itself. */
  method: 'device' | 'passphrase' | 'recovery';
}

/**
 * Encrypted, local-first profile storage.
 *
 * The profile is encrypted even on the user's own disk. It describes a person — how they
 * work, what they are building, who they are — which is exactly the kind of durable, highly
 * personal record that should not sit in plaintext at a predictable path on every machine
 * they use.
 */
export class ProfileStore {
  private readonly file: string;
  private cache?: VaultFile;
  private deviceStore?: DeviceKeyStore;

  constructor(private readonly options: StoreOptions) {
    this.file = join(options.home, 'vault.json');
  }

  get path(): string {
    return this.file;
  }

  get deviceId(): string {
    return this.options.deviceId;
  }

  async exists(): Promise<boolean> {
    return (await this.readFile()) !== undefined;
  }

  private async keyStore(): Promise<DeviceKeyStore> {
    this.deviceStore ??= await openDeviceKeyStore(this.options.home);
    return this.deviceStore;
  }

  /** Human-readable name of where this machine's key is kept, for the security screen. */
  async keyStoreName(): Promise<string> {
    return (await this.keyStore()).name;
  }

  /**
   * Create a passport. No passphrase is required or requested.
   *
   * The data key is bound to this machine's credential store for daily use and to a written
   * recovery code for everything else, which is the arrangement that lets someone who has
   * never heard of encryption end up properly protected anyway.
   */
  async initialize(input: {
    session: Omit<Session, 'device' | 'deviceId' | 'createdAt'>;
    profile: UniversalProfile;
  }): Promise<{ recoveryCode: string; keyStore: string }> {
    if (await this.exists()) {
      throw new Error(`a passport already exists at ${this.file}`);
    }

    const { keyring, dataKey } = createKeyring();
    const store = await this.keyStore();
    const { key: deviceKey } = await ensureDeviceKey(store);

    const withDevice = addDeviceSlot(
      keyring,
      dataKey,
      deviceKey,
      this.options.device,
      this.options.deviceId,
    );
    const { keyring: withRecovery, code } = addRecoverySlot(withDevice, dataKey);

    const session: Session = {
      ...input.session,
      device: this.options.device,
      deviceId: this.options.deviceId,
      createdAt: new Date().toISOString(),
    };

    await this.write({
      v: 2,
      session,
      keyring: withRecovery,
      profile: sealEnvelope(dataKey, {
        userId: session.userId,
        keyId: withRecovery.keyId,
        revision: input.profile.revision,
        plaintext: JSON.stringify({ profile: input.profile, memories: [] }),
      }),
      history: [],
    });

    return { recoveryCode: code, keyStore: store.name };
  }

  /**
   * Join an existing passport using a recovery code, then register this device.
   *
   * Registering the device slot immediately is the point: the code is typed once, ever, and
   * from then on this machine unlocks silently like the first one.
   */
  async adopt(input: {
    session: Omit<Session, 'device' | 'deviceId' | 'createdAt'>;
    recoveryCode: string;
    keyring: Keyring;
    profile: EncryptedEnvelope;
  }): Promise<{ keyStore: string }> {
    if (await this.exists()) {
      throw new Error(`a passport already exists at ${this.file}`);
    }

    const dataKey = unlockWithRecoveryCode(input.keyring, input.recoveryCode);
    const store = await this.keyStore();
    const { key: deviceKey } = await ensureDeviceKey(store);

    const keyring = addDeviceSlot(
      input.keyring,
      dataKey,
      deviceKey,
      this.options.device,
      this.options.deviceId,
    );

    await this.write({
      v: 2,
      session: {
        ...input.session,
        device: this.options.device,
        deviceId: this.options.deviceId,
        createdAt: new Date().toISOString(),
      },
      keyring,
      profile: input.profile,
      base: input.profile,
      history: [],
    });

    return { keyStore: store.name };
  }

  async session(): Promise<Session> {
    return (await this.require()).session;
  }

  async history(): Promise<Revision[]> {
    return (await this.require()).history;
  }

  async keyring(): Promise<Keyring> {
    return (await this.require()).keyring;
  }

  /**
   * Open the vault, asking the user for nothing when this device is already set up.
   *
   * Everything above this line in the stack simply calls `unlock()`; whether that involved a
   * keychain lookup or a typed code is an implementation detail, not a branch every command
   * has to carry.
   */
  async unlock(secret?: string): Promise<UnlockResult> {
    const vault = await this.require();

    if (!secret) {
      const store = await this.keyStore();
      const deviceKey = await store.get();
      if (deviceKey && hasSlot(vault.keyring, deviceSlotId(this.options.deviceId))) {
        return {
          dataKey: unlockWithDeviceKey(vault.keyring, deviceKey, this.options.deviceId),
          method: 'device',
        };
      }
      throw new UnlockError('This device is not set up yet. Enter your recovery code to add it.');
    }

    // A typed secret is either a recovery code or a passphrase; try both rather than making
    // the user tell us which kind of string they just entered.
    const errors: string[] = [];
    for (const attempt of [
      () => unlockWithRecoveryCode(vault.keyring, secret),
      () => unlockWithPassphrase(vault.keyring, secret),
    ] as const) {
      try {
        const dataKey = attempt();
        await this.registerDevice(dataKey);
        return { dataKey, method: 'recovery' };
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    throw new UnlockError(errors[0] ?? 'That code is not correct.');
  }

  /** Bind the current device so future unlocks need nothing typed. */
  async registerDevice(dataKey: Buffer): Promise<void> {
    const vault = await this.require();
    if (keyIdFor(dataKey) !== vault.keyring.keyId) return;
    if (hasSlot(vault.keyring, deviceSlotId(this.options.deviceId))) return;

    const store = await this.keyStore();
    const { key: deviceKey } = await ensureDeviceKey(store);
    vault.keyring = addDeviceSlot(
      vault.keyring,
      dataKey,
      deviceKey,
      this.options.device,
      this.options.deviceId,
    );
    await this.write(vault);
  }

  /** Issue a fresh recovery code, invalidating the previous one. */
  async resetRecoveryCode(dataKey: Buffer): Promise<string> {
    const vault = await this.require();
    const { keyring, code } = addRecoverySlot(vault.keyring, dataKey);
    vault.keyring = keyring;
    await this.write(vault);
    return code;
  }

  /** Add an optional passphrase for people who want one. */
  async setPassphrase(dataKey: Buffer, passphrase: string): Promise<void> {
    const vault = await this.require();
    vault.keyring = addPassphraseSlot(vault.keyring, dataKey, passphrase);
    await this.write(vault);
  }

  /** Fold another copy of this account's keyring into ours, keeping every device slot. */
  async mergeKeyring(remote: Keyring): Promise<void> {
    const vault = await this.require();
    vault.keyring = mergeKeyrings(vault.keyring, remote);
    await this.write(vault);
  }

  async load(dataKey: Buffer): Promise<UniversalProfile> {
    return (await this.bundle(dataKey)).profile;
  }

  /** The shared memory set, decrypted. One store, read by every agent. */
  async loadMemories(dataKey: Buffer): Promise<MemoryRecord[]> {
    return (await this.bundle(dataKey)).memories;
  }

  private async bundle(dataKey: Buffer): Promise<VaultBundle> {
    const vault = await this.require();
    return this.decode(openEnvelope(dataKey, vault.profile));
  }

  /** Decode any envelope for this account, e.g. one just pulled from the server. */
  async decodeEnvelope(dataKey: Buffer, envelope: EncryptedEnvelope): Promise<VaultBundle> {
    return this.decode(openEnvelope(dataKey, envelope));
  }

  private decode(plaintext: string): VaultBundle {
    const raw = JSON.parse(plaintext) as Partial<VaultBundle> & Record<string, unknown>;
    if (raw && typeof raw === 'object' && 'profile' in raw && raw.profile) {
      return {
        profile: parseProfile(raw.profile),
        memories: Array.isArray(raw.memories)
          ? raw.memories.map((memory) => MemoryRecordSchema.parse(memory))
          : [],
      };
    }
    return { profile: parseProfile(raw), memories: [] };
  }

  private encode(bundle: VaultBundle): string {
    return JSON.stringify(bundle);
  }

  /** The last synced state, used as the three-way merge ancestor. */
  async loadBase(dataKey: Buffer): Promise<UniversalProfile | undefined> {
    const vault = await this.require();
    if (!vault.base) return undefined;
    return this.decode(openEnvelope(dataKey, vault.base)).profile;
  }

  async save(dataKey: Buffer, profile: UniversalProfile, revision?: Revision): Promise<void> {
    const memories = await this.loadMemories(dataKey);
    await this.writeBundle(dataKey, { profile, memories }, revision);
  }

  async saveMemories(dataKey: Buffer, memories: MemoryRecord[]): Promise<void> {
    const profile = await this.load(dataKey);
    await this.writeBundle(dataKey, { profile, memories });
  }

  private async writeBundle(
    dataKey: Buffer,
    bundle: VaultBundle,
    revision?: Revision,
  ): Promise<void> {
    const vault = await this.require();
    vault.profile = sealEnvelope(dataKey, {
      userId: vault.session.userId,
      keyId: vault.keyring.keyId,
      revision: bundle.profile.revision,
      plaintext: this.encode(bundle),
    });
    if (revision) vault.history = [...vault.history, revision].slice(-50);
    await this.write(vault);
  }

  /** Record that local and remote agreed, so the next merge has an ancestor. */
  async markSynced(dataKey: Buffer, profile: UniversalProfile): Promise<void> {
    const vault = await this.require();
    const memories = await this.loadMemories(dataKey);
    vault.base = sealEnvelope(dataKey, {
      userId: vault.session.userId,
      keyId: vault.keyring.keyId,
      revision: profile.revision,
      plaintext: this.encode({ profile, memories }),
    });
    await this.write(vault);
  }

  /** The ciphertext to upload. Callers cannot accidentally send plaintext. */
  async envelope(): Promise<EncryptedEnvelope> {
    return (await this.require()).profile;
  }

  async replaceEnvelope(envelope: EncryptedEnvelope): Promise<void> {
    const vault = await this.require();
    vault.profile = envelope;
    await this.write(vault);
  }

  async destroy(): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.file, { force: true });
    try {
      await (await this.keyStore()).clear();
    } catch {
      // A credential store that refuses to clear must not block signing out.
    }
    this.cache = undefined;
  }

  private async require(): Promise<VaultFile> {
    const vault = await this.readFile();
    if (!vault) throw new Error('No passport on this computer yet.');
    return vault;
  }

  private async readFile(): Promise<VaultFile | undefined> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.file, 'utf8');
      this.cache = JSON.parse(raw) as VaultFile;
      return this.cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async write(vault: VaultFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
    this.cache = vault;
  }
}
