import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry } from '@agentpass/adapter-sdk';
import { claudeAdapter } from '@agentpass/adapter-claude';
import { codexAdapter } from '@agentpass/adapter-codex';
import { cursorAdapter } from '@agentpass/adapter-cursor';
import { openclawAdapter } from '@agentpass/adapter-openclaw';

/**
 * Every supported agent, in one place.
 *
 * Supporting a new agent is a new adapter and one line here. Nothing in the profile
 * schema, the sync engine, or the CLI needs to know it exists.
 */
export function createRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(claudeAdapter)
    .register(openclawAdapter)
    .register(codexAdapter)
    .register(cursorAdapter);
}

/** Agent Passport's own state directory. `AGENTPASS_HOME` relocates it, chiefly for tests. */
export function agentpassHome(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env['AGENTPASS_HOME'] ?? join(env['HOME'] ?? env['USERPROFILE'] ?? homedir(), '.agentpass')
  );
}

export function deviceName(env: NodeJS.ProcessEnv = process.env): string {
  return env['AGENTPASS_DEVICE'] ?? hostname();
}
