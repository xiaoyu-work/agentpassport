import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * Agent Passport's own state directory. `AGENTPASS_HOME` relocates it, chiefly for tests.
 */
export function agentpassHome(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env['AGENTPASS_HOME'] ?? join(env['HOME'] ?? env['USERPROFILE'] ?? homedir(), '.agentpass')
  );
}

/**
 * A friendly name for this machine.
 *
 * Shown in "which of your computers is this?" lists, so it should read like something a
 * person would recognise rather than a serial number.
 */
export function deviceName(env: NodeJS.ProcessEnv = process.env): string {
  if (env['AGENTPASS_DEVICE']) return env['AGENTPASS_DEVICE'];

  const host = hostname()
    .replace(/\.local$/i, '')
    .replace(/\.lan$/i, '');
  if (host && host.toLowerCase() !== 'localhost') return host;

  try {
    return `${userInfo().username}'s ${platform() === 'darwin' ? 'Mac' : 'PC'}`;
  } catch {
    return 'This computer';
  }
}

/**
 * A stable identifier for this machine, independent of its name.
 *
 * Key slots are addressed by this, so it must survive the user renaming their laptop.
 * Otherwise a rename would silently orphan the device slot and demand a recovery code again
 * for no reason the user could possibly understand.
 */
export async function deviceId(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (env['AGENTPASS_DEVICE_ID']) return env['AGENTPASS_DEVICE_ID'];

  const file = join(home, 'device-id');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // First run on this machine.
  }

  const id = randomUUID();
  await mkdir(home, { recursive: true });
  await writeFile(file, id, { mode: 0o600 });
  return id;
}
