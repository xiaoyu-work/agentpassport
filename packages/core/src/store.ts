import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createKeyring,
  keyIdFor,
  openEnvelope,
  sealEnvelope,
  unlockKeyring,
  type EncryptedEnvelope,
  type Keyring,
} from '@agentpass/crypto';
import { parseProfile, type UniversalProfile } from '@agentpass/profile';
import { MemoryRecordSchema, type MemoryRecord } from '@agentpass/memory';
import type { Revision } from '@agentpass/sync';

export interface Session {
  userId: string;
  email?: string;
  /** Issued by the sync server. Absent in fully local mode. */
  token?: string;
  serverUrl?: string;
  device: string;
  createdAt: string;
}

/**
 * What the encrypted envelope actually contains.
 *
 * Profile and memories travel together because they are worthless apart: restoring an
 * agent that has the user's MCP servers but none of their long-term memory is exactly the
 * "it doesn't know me" experience this product exists to remove. Bundling them means one
 * ciphertext, one revision, and one sync — and memory portability without requiring a
 * third-party memory account.
 */
interface VaultBundle {
  profile: UniversalProfile;
  memories: MemoryRecord[];
}

export type { VaultBundle };

/**
 * On-disk shape of the vault.
 *
 * `keyring` and `profile` are separate so the ciphertext can be uploaded verbatim: the
 * server receives exactly the bytes in `profile` and never anything that could unwrap them.
 */
interface VaultFile {
  v: 1;
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
}

/**
 * Encrypted, local-first profile storage.
 *
 * The profile is written encrypted even on the user's own disk. It carries identity, work
 * habits, and project context — a durable, high-value description of a person that would
 * otherwise sit in plaintext in a well-known path on every machine they use.
 */
export class ProfileStore {
  private readonly file: string;
  private cache?: VaultFile;

  constructor(private readonly options: StoreOptions) {
    this.file = join(options.home, 'vault.json');
  }

  get path(): string {
    return this.file;
  }

  async exists(): Promise<boolean> {
    return (await this.readFile()) !== undefined;
  }

  /** Create a vault. `passphrase` never leaves this machine. */
  async initialize(input: {
    session: Omit<Session, 'device' | 'createdAt'>;
    passphrase: string;
    profile: UniversalProfile;
  }): Promise<void> {
    if (await this.exists()) {
      throw new Error(`a passport already exists at ${this.file}; run "agentpass logout" first`);
    }
    const { keyring, dataKey } = createKeyring(input.passphrase);
    const session: Session = {
      ...input.session,
      device: this.options.device,
      createdAt: new Date().toISOString(),
    };
    await this.write({
      v: 1,
      session,
      keyring,
      profile: sealEnvelope(dataKey, {
        userId: session.userId,
        keyId: keyring.keyId,
        revision: input.profile.revision,
        plaintext: JSON.stringify({ profile: input.profile, memories: [] }),
      }),
      history: [],
    });
  }

  /**
   * Join an existing passport from another device.
   *
   * The keyring arrives from the server still wrapped; only the passphrase can open it.
   * Minting a fresh key here instead — which is the obvious-looking thing to do — would
   * leave the new device unable to read anything the old one wrote, which is precisely the
   * failure this product exists to prevent.
   */
  async adopt(input: {
    session: Omit<Session, 'device' | 'createdAt'>;
    passphrase: string;
    keyring: Keyring;
    profile: EncryptedEnvelope;
  }): Promise<void> {
    if (await this.exists()) {
      throw new Error(`a passport already exists at ${this.file}; run "agentpass logout" first`);
    }

    let dataKey: Buffer;
    try {
      dataKey = unlockKeyring(input.keyring, input.passphrase);
    } catch {
      throw new Error(
        'that passphrase does not match this account. Use the passphrase from your other device.',
      );
    }
    if (keyIdFor(dataKey) !== input.keyring.keyId) {
      throw new Error('that passphrase does not match this account');
    }

    await this.write({
      v: 1,
      session: {
        ...input.session,
        device: this.options.device,
        createdAt: new Date().toISOString(),
      },
      keyring: input.keyring,
      profile: input.profile,
      base: input.profile,
      history: [],
    });
  }

  /** The wrapped data key. Safe to upload: it is useless without the passphrase. */
  async keyring(): Promise<Keyring> {
    return (await this.require()).keyring;
  }

  async session(): Promise<Session> {
    return (await this.require()).session;
  }

  async history(): Promise<Revision[]> {
    return (await this.require()).history;
  }

  /** Unwrap the data key. Every read and write of profile data goes through this. */
  async unlock(passphrase: string): Promise<Buffer> {
    const vault = await this.require();
    const dataKey = unlockKeyring(vault.keyring, passphrase);
    if (keyIdFor(dataKey) !== vault.keyring.keyId) {
      throw new Error('incorrect passphrase');
    }
    return dataKey;
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

  /** Tolerates vaults written before memories shared the envelope. */
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
    this.cache = undefined;
  }

  private async require(): Promise<VaultFile> {
    const vault = await this.readFile();
    if (!vault) throw new Error('not signed in. Run "agentpass login" first');
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
