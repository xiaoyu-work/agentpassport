import { AGENT_CATALOG, discoverAgents, type Passport } from '@agentpassport/core';
import { bullet, cyan, dim, heading, line, ok, warn, yellow } from '../ui.js';

/** Show which adapter plugins are loaded, missing, or broken. */
export async function pluginsCommand(passport: Passport): Promise<number> {
  const { loaded, failed } = await passport.loadPlugins();
  const discovered = await discoverAgents(passport);

  heading('Installed plugins');
  if (loaded.length === 0) {
    warn('No adapter plugins are installed.');
  }
  for (const plugin of loaded) {
    const version = plugin.version ? ` v${plugin.version}` : '';
    ok(`${plugin.displayName}${version} ${dim(`(${plugin.id}, ${plugin.origin})`)}`);
  }

  const missing = discovered.filter((a) => a.installed && !a.pluginInstalled);
  if (missing.length > 0) {
    heading('Detected here, but no plugin installed');
    for (const agent of missing) {
      line(`  ${yellow('●')} ${agent.displayName}`);
      for (const file of agent.files.slice(0, 3)) bullet(dim(`  ${file.path}`));
      if (agent.package) bullet(cyan(`  npm install ${agent.package}`));
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
  return 0;
}
