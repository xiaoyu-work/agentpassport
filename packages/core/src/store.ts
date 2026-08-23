import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  addDeviceSlot,
  addPassphraseSlot,
  addRecoverySlot,
  createKeyring,
  deviceSlotId,
  hasSlot,
  unlockWithDeviceKey,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  UnlockError,
  type EncryptedEnvelope,
  type Keyring,
} from '@agentpassport/crypto';
import { ensureDeviceKey, openDeviceKeyStore, type DeviceKeyStore } from './device-key.js';

export interface Session {
  userId: string;
  email?: string;
  device: string;
  deviceId: string;
  createdAt: string;
}

interface VaultFile {
  v: 2;
  session: Session;
  keyring: Keyring;
  history: Revision[];
}

export interface Revision {
  id: string;
  at: string;
  device: string;
  revision: number;
}

export interface StoreOptions {
  home: string;
  device: string;
  deviceId: string;
}

export interface UnlockResult {
  dataKey: Buffer;
  method: 'device' | 'passphrase' | 'recovery';
}

/**
 * Encrypted, local-first vault storage. Holds keyring + session metadata; per-agent
 * snapshots live in sibling files under `agents/<agent>/snapshot.enc.json`.
 */
export class VaultStore {
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
    if (!this.deviceStore) {
      this.deviceStore = await openDeviceKeyStore(this.options.home);
    }
    return this.deviceStore;
  }

  async keyStoreName(): Promise<string> {
    return (await this.keyStore()).name;
  }

  async initialize(input: {
    session: Omit<Session, 'device' | 'deviceId' | 'createdAt'>;
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

    await this.write({ v: 2, session, keyring: withRecovery, history: [] });
    return { recoveryCode: code, keyStore: store.name };
  }

  async adopt(input: {
    session: Omit<Session, 'device' | 'deviceId' | 'createdAt'>;
    recoveryCode: string;
    keyring: Keyring;
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
      history: [],
    });

    // dataKey used only to prove recovery code; discard.
    void dataKey;
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

  async unlock(secret?: string): Promise<UnlockResult> {
    const vault = await this.require();
    const store = await this.keyStore();

    if (hasSlot(vault.keyring, deviceSlotId(this.options.deviceId))) {
      try {
        const { key } = await ensureDeviceKey(store);
        return { dataKey: unlockWithDeviceKey(vault.keyring, key, this.options.deviceId), method: 'device' };
      } catch (error) {
        if (!(error instanceof UnlockError)) throw error;
      }
    }

    if (secret) {
      try {
        return { dataKey: unlockWithRecoveryCode(vault.keyring, secret), method: 'recovery' };
      } catch (error) {
        if (!(error instanceof UnlockError)) throw error;
      }
      try {
        return { dataKey: unlockWithPassphrase(vault.keyring, secret), method: 'passphrase' };
      } catch (error) {
        if (!(error instanceof UnlockError)) throw error;
      }
    }

    throw new UnlockError('Could not unlock this passport.');
  }

  async registerDevice(dataKey: Buffer): Promise<void> {
    const vault = await this.require();
    const store = await this.keyStore();
    const { key } = await ensureDeviceKey(store);
    vault.keyring = addDeviceSlot(vault.keyring, dataKey, key, this.options.device, this.options.deviceId);
    await this.write(vault);
  }

  async resetRecoveryCode(dataKey: Buffer): Promise<string> {
    const vault = await this.require();
    const { keyring, code } = addRecoverySlot(vault.keyring, dataKey);
    vault.keyring = keyring;
    await this.write(vault);
    return code;
  }

  async setPassphrase(dataKey: Buffer, passphrase: string): Promise<void> {
    const vault = await this.require();
    vault.keyring = addPassphraseSlot(vault.keyring, dataKey, passphrase);
    await this.write(vault);
  }

  async destroy(): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.file, { force: true });
    try {
      await (await this.keyStore()).clear();
    } catch {
      /* refusing to clear a credential store must not block sign-out */
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

/** @deprecated use VaultStore */
export const ProfileStore = VaultStore;
