import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { randomKey } from '@agentpassport/crypto';

const run = promisify(execFile);

const SERVICE = 'AgentPassport';
const ACCOUNT = 'device-key';

/** Round-trips a value through DPAPI to prove the capability really exists here. */
const PROBE_SCRIPT =
  'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; ' +
  "ConvertTo-SecureString -String 'probe' -AsPlainText -Force | ConvertFrom-SecureString";

/**
 * Where this machine's device key lives.
 *
 * The device key is what makes daily use require nothing from the user, so it has to be
 * stored somewhere the operating system already protects with the login session. Every
 * backend here is reached by shelling out to a tool the OS ships, deliberately avoiding a
 * native module: a compiler toolchain requirement would put the install back behind exactly
 * the wall this design exists to remove.
 */
export interface DeviceKeyStore {
  readonly name: string;
  available(): Promise<boolean>;
  get(): Promise<Buffer | undefined>;
  set(key: Buffer): Promise<void>;
  clear(): Promise<void>;
}

/** macOS Keychain, unlocked by the user's login session. */
class MacKeychainStore implements DeviceKeyStore {
  readonly name = 'macOS Keychain';

  async available(): Promise<boolean> {
    if (platform() !== 'darwin') return false;
    try {
      await run('security', ['-h'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async get(): Promise<Buffer | undefined> {
    try {
      const { stdout } = await run(
        'security',
        ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'],
        { timeout: 10000 },
      );
      const value = stdout.trim();
      return value ? Buffer.from(value, 'base64') : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: Buffer): Promise<void> {
    await run(
      'security',
      ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', key.toString('base64'), '-U'],
      { timeout: 10000 },
    );
  }

  async clear(): Promise<void> {
    try {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], {
        timeout: 10000,
      });
    } catch {
      // Nothing to delete is success.
    }
  }
}

/** Windows DPAPI, which ties the ciphertext to the current user account. */
class WindowsDpapiStore implements DeviceKeyStore {
  readonly name = 'Windows account protection';

  constructor(private readonly file: string) {}

  /**
   * Probe by actually encrypting something.
   *
   * Checking the platform is not enough: locked-down and constrained PowerShell setups
   * refuse to autoload `Microsoft.PowerShell.Security`, so DPAPI is present in theory and
   * broken in practice. Discovering that during `set()` would leave a user unable to create
   * a passport at all, so the capability is tested rather than assumed.
   */
  async available(): Promise<boolean> {
    if (platform() !== 'win32') return false;
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', PROBE_SCRIPT], {
        timeout: 20000,
      });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async get(): Promise<Buffer | undefined> {
    let encrypted: string;
    try {
      encrypted = (await readFile(this.file, 'utf8')).trim();
    } catch {
      return undefined;
    }
    if (!encrypted) return undefined;

    try {
      const script =
        `$s = '${encrypted}' | ConvertTo-SecureString; ` +
        `[Runtime.InteropServices.Marshal]::PtrToStringAuto(` +
        `[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`;
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], {
        timeout: 15000,
      });
      const value = stdout.trim();
      return value ? Buffer.from(value, 'base64') : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: Buffer): Promise<void> {
    const script =
      'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; ' +
      `ConvertTo-SecureString -String '${key.toString('base64')}' ` +
      `-AsPlainText -Force | ConvertFrom-SecureString`;
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], {
      timeout: 15000,
    });
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, stdout.trim(), { mode: 0o600 });
  }

  async clear(): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.file, { force: true });
  }
}

/** Linux desktops with libsecret, which is what GNOME Keyring and KWallet expose. */
class SecretToolStore implements DeviceKeyStore {
  readonly name = 'system keyring';

  async available(): Promise<boolean> {
    if (platform() === 'win32' || platform() === 'darwin') return false;
    try {
      await run('secret-tool', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async get(): Promise<Buffer | undefined> {
    try {
      const { stdout } = await run(
        'secret-tool',
        ['lookup', 'service', SERVICE, 'account', ACCOUNT],
        { timeout: 10000 },
      );
      const value = stdout.trim();
      return value ? Buffer.from(value, 'base64') : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'secret-tool',
        ['store', '--label', 'Agent Passport device key', 'service', SERVICE, 'account', ACCOUNT],
        (error) => (error ? reject(error) : resolve()),
      );
      child.stdin?.end(key.toString('base64'));
    });
  }

  async clear(): Promise<void> {
    try {
      await run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT], {
        timeout: 10000,
      });
    } catch {
      // Nothing to clear is success.
    }
  }
}

/**
 * Last resort: a file only this user can read.
 *
 * Weaker than a real credential store, and named so that `agentpass` can say so plainly
 * rather than implying protection it does not have. Still far better than the alternative
 * of making every user invent a passphrase.
 */
class FileStore implements DeviceKeyStore {
  readonly name = 'protected file';

  constructor(private readonly file: string) {}

  async available(): Promise<boolean> {
    return true;
  }

  async get(): Promise<Buffer | undefined> {
    try {
      const raw = (await readFile(this.file, 'utf8')).trim();
      return raw ? Buffer.from(raw, 'base64') : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: Buffer): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, key.toString('base64'), { mode: 0o600 });
    try {
      await chmod(this.file, 0o600);
    } catch {
      // Windows ignores POSIX modes; the file still sits in the user profile.
    }
  }

  async clear(): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.file, { force: true });
  }
}

export async function openDeviceKeyStore(home: string): Promise<DeviceKeyStore> {
  const candidates: DeviceKeyStore[] = [
    new MacKeychainStore(),
    new WindowsDpapiStore(join(home, 'device.dpapi')),
    new SecretToolStore(),
    new FileStore(join(home, 'device.key')),
  ];
  const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));

  // Probing costs a subprocess launch, which is too much to pay on every command. The
  // answer only changes when the machine changes, so it is remembered.
  const markerFile = join(home, 'keystore.json');
  try {
    const marker = JSON.parse(await readFile(markerFile, 'utf8')) as { name?: string };
    const remembered = marker.name ? byName.get(marker.name) : undefined;
    if (remembered) return remembered;
  } catch {
    // No marker yet; probe below.
  }

  for (const candidate of candidates) {
    if (!(await candidate.available())) continue;
    try {
      await mkdir(home, { recursive: true });
      await writeFile(markerFile, JSON.stringify({ name: candidate.name }), { mode: 0o600 });
    } catch {
      // Failing to remember the choice only costs a repeat probe.
    }
    return candidate;
  }

  return new FileStore(join(home, 'device.key'));
}

/** Fetch this machine's device key, creating one on first use. */
export async function ensureDeviceKey(
  store: DeviceKeyStore,
): Promise<{ key: Buffer; created: boolean }> {
  const existing = await store.get();
  if (existing && existing.length === 32) return { key: existing, created: false };
  const key = randomKey();
  await store.set(key);
  return { key, created: true };
}
