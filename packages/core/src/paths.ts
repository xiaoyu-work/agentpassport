import { hostname, homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Agent Passport's own state directory. `AGENTPASS_HOME` relocates it, chiefly for tests.
 */
export function agentpassHome(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env['AGENTPASS_HOME'] ?? join(env['HOME'] ?? env['USERPROFILE'] ?? homedir(), '.agentpass')
  );
}

export function deviceName(env: NodeJS.ProcessEnv = process.env): string {
  return env['AGENTPASS_DEVICE'] ?? hostname();
}
