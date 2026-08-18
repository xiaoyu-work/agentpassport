import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { EncryptedEnvelope, Keyring } from '@agentpassport/crypto';
import { ConflictError, type RemoteProfile, type RemoteStore } from './remote.js';

const run = promisify(execFile);

const FILENAME = 'passport.json';

/**
 * Where a synced profile is written, whatever the transport.
 *
 * Every backend moves the same document, so switching between a folder, a git repo, and a
 * hosted server is a change of transport rather than a change of format.
 */
interface SyncDocument {
  v: 1;
  envelope: EncryptedEnvelope;
  keyring: Keyring;
  revision: number;
  updatedAt: string;
}

function toRemote(document: SyncDocument): RemoteProfile {
  return {
    envelope: document.envelope,
    keyring: document.keyring,
    revision: document.revision,
    updatedAt: document.updatedAt,
  };
}

async function readDocument(file: string): Promise<SyncDocument | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as SyncDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeDocument(file: string, document: SyncDocument): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function guardRevision(current: SyncDocument | undefined, envelope: EncryptedEnvelope): void {
  if (current && envelope.revision < current.revision) {
    throw new ConflictError('another computer has newer changes; sync again to merge them');
  }
}

/**
 * Sync through a folder that something else already keeps in step.
 *
 * Dropbox, iCloud Drive, OneDrive, a network share, even a USB stick. The profile is
 * already ciphertext by the time it lands here, so the folder provider learns nothing —
 * which is what makes borrowing someone else's sync infrastructure acceptable rather than
 * a compromise.
 */
export class FolderRemoteStore implements RemoteStore {
  constructor(private readonly directory: string) {}

  private file(userId: string): string {
    return join(this.directory, encodeURIComponent(userId), FILENAME);
  }

  async pull(userId: string): Promise<RemoteProfile | undefined> {
    const document = await readDocument(this.file(userId));
    return document ? toRemote(document) : undefined;
  }

  async push(
    userId: string,
    envelope: EncryptedEnvelope,
    keyring: Keyring,
  ): Promise<RemoteProfile> {
    const file = this.file(userId);
    guardRevision(await readDocument(file), envelope);

    const document: SyncDocument = {
      v: 1,
      envelope,
      keyring,
      revision: envelope.revision,
      updatedAt: new Date().toISOString(),
    };
    await writeDocument(file, document);
    return toRemote(document);
  }
}

export class GitSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitSyncError';
  }
}

/**
 * Sync through a git repository.
 *
 * Developers already have somewhere to push a private repo, which makes this the cheapest
 * possible answer to "how do I get my profile onto another machine" — no server to run, no
 * account to create, and a full history of every change for free.
 *
 * Git is only the transport. Merging still happens in the client, on decrypted data, so a
 * conflict is resolved field by field rather than by asking anyone to reconcile ciphertext.
 */
export class GitRemoteStore implements RemoteStore {
  constructor(
    private readonly remoteUrl: string,
    private readonly checkout: string,
    private readonly branch = 'main',
  ) {}

  private async git(args: string[], allowFailure = false): Promise<string> {
    try {
      const { stdout } = await run('git', ['-C', this.checkout, ...args], {
        timeout: 60000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return stdout.trim();
    } catch (error) {
      if (allowFailure) return '';
      const detail = (error as { stderr?: string }).stderr ?? (error as Error).message;
      throw new GitSyncError(`git ${args[0]} failed: ${detail.trim()}`);
    }
  }

  /** Clone on first use, then fast-forward. */
  private async ensureCheckout(): Promise<void> {
    let cloned = true;
    try {
      await readFile(join(this.checkout, '.git', 'HEAD'), 'utf8');
    } catch {
      cloned = false;
    }

    if (!cloned) {
      await mkdir(dirname(this.checkout), { recursive: true });
      try {
        await run('git', ['clone', '--depth', '1', this.remoteUrl, this.checkout], {
          timeout: 120000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        return;
      } catch {
        // A repository with no commits yet cannot be cloned; start one locally and let the
        // first push populate it.
        await mkdir(this.checkout, { recursive: true });
        await this.git(['init', '--initial-branch', this.branch]);
        await this.git(['remote', 'add', 'origin', this.remoteUrl], true);
      }
    }

    await this.git(['fetch', 'origin', this.branch], true);
    await this.git(['checkout', '-B', this.branch], true);
    await this.git(['reset', '--hard', `origin/${this.branch}`], true);
  }

  private file(userId: string): string {
    return join(this.checkout, encodeURIComponent(userId), FILENAME);
  }

  async pull(userId: string): Promise<RemoteProfile | undefined> {
    await this.ensureCheckout();
    const document = await readDocument(this.file(userId));
    return document ? toRemote(document) : undefined;
  }

  async push(
    userId: string,
    envelope: EncryptedEnvelope,
    keyring: Keyring,
  ): Promise<RemoteProfile> {
    await this.ensureCheckout();
    const file = this.file(userId);
    guardRevision(await readDocument(file), envelope);

    const document: SyncDocument = {
      v: 1,
      envelope,
      keyring,
      revision: envelope.revision,
      updatedAt: new Date().toISOString(),
    };
    await writeDocument(file, document);

    await this.git(['add', '--all']);
    const status = await this.git(['status', '--porcelain']);
    if (status) {
      await this.git([
        '-c',
        'user.name=Agent Passport',
        '-c',
        'user.email=agentpass@localhost',
        'commit',
        '-m',
        `passport: revision ${envelope.revision}`,
      ]);
    }
    await this.git(['push', 'origin', `HEAD:${this.branch}`]);

    return toRemote(document);
  }
}
