import { join } from 'node:path';

export interface AdapterContext {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  device?: string;
  deviceId?: string;
}

export interface CodexPaths {
  home: string;
  configFile: string;
  globalAgents: string;
  projectAgents: string;
  skillsDir: string;
}

/** `CODEX_HOME` relocates the entire Codex directory, including `config.toml`. */
export function codexPaths(context: AdapterContext): CodexPaths {
  const home = (context.env['CODEX_HOME'] as string | undefined) ?? join(context.home, '.codex');
  return {
    home,
    configFile: join(home, 'config.toml'),
    globalAgents: join(home, 'AGENTS.md'),
    projectAgents: join(context.cwd, 'AGENTS.md'),
    skillsDir: join(home, 'skills'),
  };
}

/** Files that belong in a Codex identity snapshot. Global scope only. */
export function snapshotEntries(paths: CodexPaths): string[] {
  return [paths.configFile, paths.globalAgents, paths.skillsDir];
}
