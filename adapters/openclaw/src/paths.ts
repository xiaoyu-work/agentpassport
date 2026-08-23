import { isAbsolute, join, resolve } from 'node:path';
import type { AdapterContextLike as AdapterContext } from './context.js';

/**
 * OpenClaw's on-disk layout, mirroring `src/config/paths.ts` and
 * `src/agents/workspace-default.ts` in the OpenClaw source.
 *
 * Three environment variables move things independently: `OPENCLAW_CONFIG_PATH` relocates
 * only the config file, `OPENCLAW_STATE_DIR` moves the whole state tree, and
 * `OPENCLAW_WORKSPACE_DIR` moves only the workspace. Resolving them in the wrong order
 * writes a perfectly valid config file that OpenClaw never reads.
 */
export interface OpenClawPaths {
  stateDir: string;
  configFile: string;
  workspaceDir: string;
  agentsFile: string;
  userFile: string;
  memoryFile: string;
  soulFile: string;
  toolsFile: string;
  identityFile: string;
  heartbeatFile: string;
  memoryDir: string;
  skillsDir: string;
  agentsDir: string;
}

/**
 * Every file/directory that belongs in an OpenClaw identity snapshot.
 *
 * Ordered so a human reading the manifest sees the persona files first (SOUL, IDENTITY,
 * AGENTS, USER, TOOLS) before the state (MEMORY, memory/, config, skills, agents/).
 *
 * `agentsDir` (~/.openclaw/agents) holds each agent's sqlite auth store — provider API
 * keys, OAuth tokens. Backing it up means a fresh machine restores your logins along
 * with your identity. Session transcripts under `agents/<id>/sessions/` are the one
 * carve-out from that tree, filtered at snapshot time because they are large and
 * privacy-heavy.
 */
export function snapshotEntries(paths: OpenClawPaths): string[] {
  return [
    paths.soulFile,
    paths.identityFile,
    paths.agentsFile,
    paths.userFile,
    paths.toolsFile,
    paths.memoryFile,
    paths.heartbeatFile,
    paths.memoryDir,
    paths.configFile,
    paths.skillsDir,
    paths.agentsDir,
  ];
}

export function openclawPaths(context: AdapterContext): OpenClawPaths {
  const stateDir = context.env['OPENCLAW_STATE_DIR']
    ? resolvePath(context, context.env['OPENCLAW_STATE_DIR'])
    : join(context.home, '.openclaw');

  const configFile = context.env['OPENCLAW_CONFIG_PATH']
    ? resolvePath(context, context.env['OPENCLAW_CONFIG_PATH'])
    : join(stateDir, 'openclaw.json');

  const workspaceDir = context.env['OPENCLAW_WORKSPACE_DIR']
    ? resolvePath(context, context.env['OPENCLAW_WORKSPACE_DIR'])
    : join(stateDir, 'workspace');

  return {
    stateDir,
    configFile,
    workspaceDir,
    agentsFile: join(workspaceDir, 'AGENTS.md'),
    userFile: join(workspaceDir, 'USER.md'),
    memoryFile: join(workspaceDir, 'MEMORY.md'),
    soulFile: join(workspaceDir, 'SOUL.md'),
    toolsFile: join(workspaceDir, 'TOOLS.md'),
    identityFile: join(workspaceDir, 'IDENTITY.md'),
    heartbeatFile: join(workspaceDir, 'HEARTBEAT.md'),
    memoryDir: join(workspaceDir, 'memory'),
    skillsDir: join(stateDir, 'skills'),
    agentsDir: join(stateDir, 'agents'),
  };
}

function resolvePath(context: AdapterContext, value: string): string {
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(context.home, value.slice(2));
  return isAbsolute(value) ? value : resolve(context.cwd, value);
}

/** OpenClaw calls streamable HTTP `streamable-http`, where Claude Code calls it `http`. */
export type OpenClawTransport = 'stdio' | 'sse' | 'streamable-http';

export interface OpenClawMcpServer {
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string | number | boolean>;
  cwd?: string;
  url?: string;
  transport?: OpenClawTransport;
  headers?: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

export type OpenClawModel = string | { primary?: string; fallbacks?: string[] };

export interface OpenClawConfig {
  mcp?: { servers?: Record<string, OpenClawMcpServer>; [key: string]: unknown };
  agents?: {
    defaults?: { model?: OpenClawModel; [key: string]: unknown };
    entries?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };
  skills?: {
    entries?: Record<string, { enabled?: boolean; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function primaryModel(model: OpenClawModel | undefined): string | undefined {
  if (!model) return undefined;
  return typeof model === 'string' ? model : model.primary;
}
