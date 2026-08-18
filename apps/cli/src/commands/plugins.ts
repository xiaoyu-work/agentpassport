import { AGENT_CATALOG, discoverAgents, missingPlugins, type Passport } from '@agentpassport/core';
import { bullet, cyan, dim, heading, line, ok, warn, yellow } from '../ui.js';

/**
 * Show which adapter plugins are loaded, missing, or broken.
 *
 * Adapters are optional by design, so "which agents can I actually act on right now?" is a
 * question the CLI has to answer plainly rather than leaving users to infer from a
 * confusing failure later.
 */
export async function pluginsCommand(passport: Passport): Promise<number> {
  const { loaded, failed } = await passport.loadPlugins();
  const discovered = await discoverAgents(passport);

  heading('Installed plugins');
  if (loaded.length === 0) {
    warn('No adapter plugins are installed.');
    line(dim('Agent Passport still stores and syncs your profile, but cannot read agents.'));
  }
  for (const plugin of loaded) {
    const version = plugin.version ? ` v${plugin.version}` : '';
    ok(`${plugin.displayName}${version} ${dim(`(${plugin.id}, ${plugin.origin})`)}`);
  }

  const missing = missingPlugins(discovered);
  if (missing.length > 0) {
    heading('Detected here, but no plugin installed');
    for (const agent of missing) {
      line(`  ${yellow('●')} ${agent.displayName}`);
      for (const file of agent.files.slice(0, 3)) bullet(dim(`  ${file.path}`));
      bullet(cyan(`  npm install ${agent.package}`));
    }
  }

  const notInstalled = AGENT_CATALOG.filter(
    (entry) => !loaded.some((plugin) => plugin.id === entry.id),
  ).filter((entry) => !missing.some((agent) => agent.id === entry.id));

  if (notInstalled.length > 0) {
    heading('Available');
    for (const entry of notInstalled) {
      line(`  ${dim('·')} ${dim(`${entry.displayName} — ${entry.package}`)}`);
    }
  }

  if (failed.length > 0) {
    heading('Failed to load');
    for (const failure of failed) {
      warn(`${failure.specifier}: ${failure.reason}`);
    }
  }

  line('');
  line(dim('Plugins are discovered automatically from node_modules and ~/.agentpass/plugins.'));
  return 0;
}
