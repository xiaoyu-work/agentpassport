import { discoverAgents, type Passport } from '@agentpass/core';
import { summarizeSharing } from '@agentpass/memory';
import { bullet, cyan, dim, formatBytes, heading, line, ok, readPassphrase, warn } from '../ui.js';

/**
 * Show what is installed on this machine.
 *
 * Runs before sign-in too, because the most persuasive thing Agent Passport can do on
 * first contact is correctly name the agents someone already uses.
 */
export async function scan(passport: Passport): Promise<number> {
  const discovered = await discoverAgents(passport);
  const installed = discovered.filter((agent) => agent.installed);

  heading('Agents on this machine');
  if (installed.length === 0) {
    warn('No supported agents found.');
    line(dim('Looked for Claude Code, OpenClaw, Codex, and Cursor in their standard locations.'));
    return 0;
  }

  for (const agent of discovered) {
    if (!agent.installed) {
      line(`  ${dim('·')} ${dim(`${agent.displayName} — not found`)}`);
      continue;
    }
    line(`  ${cyan('●')} ${agent.displayName} ${dim(`(${agent.id})`)}`);
    for (const file of agent.files) {
      bullet(dim(`  ${file.kind.padEnd(12)} ${file.path} ${formatBytes(file.bytes)}`));
    }
  }

  line('');
  line(`Found ${installed.length} agent(s). Run ${dim('agentpass import')} to bring them in.`);
  return 0;
}

export async function status(passport: Passport): Promise<number> {
  if (!(await passport.store.exists())) {
    warn('Not signed in.');
    line(dim('Run "agentpass login" to create a passport.'));
    return 1;
  }

  const session = await passport.store.session();
  heading('Passport');
  bullet(`User      ${session.userId}`);
  bullet(`Device    ${session.device}`);
  bullet(`Cloud     ${session.serverUrl ?? dim('local only')}`);
  bullet(`Vault     ${passport.store.path}`);

  let passphrase: string;
  try {
    passphrase = await readPassphrase();
  } catch {
    return 1;
  }

  const dataKey = await passport.store.unlock(passphrase);
  const profile = await passport.store.load(dataKey);

  heading('Profile');
  bullet(`Revision         ${profile.revision}`);
  bullet(`Identity         ${profile.identity.displayName ?? dim('unset')}`);
  bullet(`MCP servers      ${profile.mcp.length}`);
  bullet(`Skills           ${profile.skills.length}`);
  bullet(`Workspace rules  ${profile.workspace.rules.length}`);
  bullet(`Secret refs      ${Object.keys(profile.secrets.references).length}`);

  const provider = passport.memory(profile, dataKey);
  const memories = await provider.list(profile.identity.userId);
  const sharing = summarizeSharing(memories);

  heading(`Memory (${provider.name})`);
  line(dim('  One store. Every agent reads from it.'));
  bullet(`Total active     ${sharing.total}`);
  bullet(`${cyan('Shared with all')}  ${sharing.shared}`);
  if (sharing.agentSpecific > 0) {
    bullet(`Agent-specific   ${sharing.agentSpecific}`);
    for (const [agent, count] of Object.entries(sharing.byAgent).sort()) {
      bullet(dim(`  ${agent}: ${count}`));
    }
  }

  const installed = (await discoverAgents(passport)).filter((agent) => agent.installed);
  heading('Agents');
  for (const agent of installed) {
    const visible = sharing.shared + (sharing.byAgent[agent.id] ?? 0);
    ok(`${agent.displayName} ${dim(`— sees ${visible} memor${visible === 1 ? 'y' : 'ies'}`)}`);
  }

  if (Object.keys(profile.secrets.references).length > 0) {
    const availability = await passport.secrets.check(profile.secrets.references);
    heading('Secret references');
    for (const [name, reachable] of Object.entries(availability)) {
      const reference = profile.secrets.references[name] ?? '';
      if (reachable) ok(`${name} ${dim(`-> ${reference}`)}`);
      else warn(`${name} ${dim(`-> ${reference} (provider unavailable)`)}`);
    }
  }

  return 0;
}
