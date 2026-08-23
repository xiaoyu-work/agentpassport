import { join } from 'node:path';
import type { AdapterContext } from '@agentpassport/adapter-sdk';

/**
 * Claude Code's on-disk layout.
 *
 * `CLAUDE_CONFIG_DIR` relocates the config directory; `~/.claude.json` stays beside the
 * home directory regardless, because Claude Code keeps MCP servers and per-project trust
 * state there rather than in the settings directory.
 */
export interface ClaudePaths {
  configDir: string;
  userSettings: string;
  userMemory: string;
  /** MCP servers (user scope) plus per-project state. */
  globalJson: string;
  skillsDir: string;
  projectMemory: string;
  projectMemoryAlt: string;
  projectSettings: string;
  projectMcp: string;
}

export function claudePaths(context: AdapterContext): ClaudePaths {
  const configDir = context.env['CLAUDE_CONFIG_DIR'] ?? join(context.home, '.claude');
  return {
    configDir,
    userSettings: join(configDir, 'settings.json'),
    userMemory: join(configDir, 'CLAUDE.md'),
    globalJson: join(context.home, '.claude.json'),
    skillsDir: join(configDir, 'skills'),
    projectMemory: join(context.cwd, 'CLAUDE.md'),
    projectMemoryAlt: join(context.cwd, '.claude', 'CLAUDE.md'),
    projectSettings: join(context.cwd, '.claude', 'settings.json'),
    projectMcp: join(context.cwd, '.mcp.json'),
  };
}

/**
 * Files that belong in a Claude Code identity snapshot.
 *
 * Global scope only — project-scoped files live in the project repo and
 * shouldn't be part of an agent's portable identity.
 */
export function snapshotEntries(paths: ClaudePaths): string[] {
  return [paths.userSettings, paths.userMemory, paths.globalJson, paths.skillsDir];
}

/** Claude Code's MCP server entry. Note `type`, where most agents write `transport`. */
export interface ClaudeMcpServer {
  type?: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface ClaudeSettings {
  model?: string;
  outputStyle?: string;
  env?: Record<string, string>;
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ClaudeGlobalJson {
  mcpServers?: Record<string, ClaudeMcpServer>;
  projects?: Record<string, { mcpServers?: Record<string, ClaudeMcpServer> }>;
  [key: string]: unknown;
}

export interface ClaudeMcpFile {
  mcpServers?: Record<string, ClaudeMcpServer>;
  [key: string]: unknown;
}
