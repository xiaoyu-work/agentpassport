import { join } from 'node:path';

export interface AdapterContext {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  device?: string;
  deviceId?: string;
}

const PASSPORT_RULE_FILE = 'agent-passport.mdc';

export interface CursorPaths {
  rulesDir: string;
  passportRule: string;
  projectMcp: string;
  globalMcp: string;
  agentsFile: string;
}

export function cursorPaths(context: AdapterContext): CursorPaths {
  const rulesDir = join(context.cwd, '.cursor', 'rules');
  return {
    rulesDir,
    passportRule: join(rulesDir, PASSPORT_RULE_FILE),
    projectMcp: join(context.cwd, '.cursor', 'mcp.json'),
    globalMcp: join(context.home, '.cursor', 'mcp.json'),
    agentsFile: join(context.cwd, 'AGENTS.md'),
  };
}

/** Files that belong in a Cursor identity snapshot. Global MCP only. */
export function snapshotEntries(paths: CursorPaths): string[] {
  return [paths.globalMcp];
}
