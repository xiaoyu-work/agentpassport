import { join } from 'node:path';
import {
  ProfileBuilder,
  applyManagedBlock,
  applyPlan,
  describeChange,
  expandEnv,
  inferWorkspaceHints,
  mergePreserving,
  parseInstructions,
  readSkillsDir,
  readManagedBlock,
  readTextIfExists,
  redactEnv,
  renderInstructions,
  renderSkillFile,
  skillFilePath,
  stripManagedBlock,
  toCanonicalModel,
  toNativeModel,
  writeFileAtomic,
  type AdapterContext,
  type AdapterWarning,
  type AgentAdapter,
  type AgentConfigDiff,
  type ConfigChange,
  type ExportResult,
  type ImportResult,
  type ValidationIssue,
  type ValidationResult,
} from '@agentpass/adapter-sdk';
import { extractMemories, type MemoryDraft, type MemoryRecord } from '@agentpass/memory';
import { createEmptyProfile, type McpServer, type UniversalProfile } from '@agentpass/profile';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

const AGENT_ID = 'codex';
const GLOBAL_RULE_ID = 'codex-global-agents-md';
const PROJECT_RULE_ID = 'codex-project-agents-md';

export interface CodexPaths {
  home: string;
  configFile: string;
  globalAgents: string;
  projectAgents: string;
  skillsDir: string;
}

/** `CODEX_HOME` relocates the entire Codex directory, including `config.toml`. */
export function codexPaths(context: AdapterContext): CodexPaths {
  const home = context.env['CODEX_HOME'] ?? join(context.home, '.codex');
  return {
    home,
    configFile: join(home, 'config.toml'),
    globalAgents: join(home, 'AGENTS.md'),
    projectAgents: join(context.cwd, 'AGENTS.md'),
    skillsDir: join(home, 'skills'),
  };
}

interface CodexMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  startup_timeout_sec?: number;
  [key: string]: unknown;
}

interface CodexConfig {
  model?: string;
  model_reasoning_effort?: string;
  approval_policy?: string;
  sandbox_mode?: string;
  mcp_servers?: Record<string, CodexMcpServer>;
  [key: string]: unknown;
}

/**
 * OpenAI Codex CLI adapter.
 *
 * Codex is the only supported agent that stores configuration as TOML, and it spells MCP
 * servers `[mcp_servers.<name>]` with a nested `env` table rather than the `mcpServers`
 * JSON object every other agent uses.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = AGENT_ID;
  readonly displayName = 'OpenAI Codex';

  async detect(context: AdapterContext): Promise<boolean> {
    const paths = codexPaths(context);
    for (const candidate of [paths.configFile, paths.globalAgents, paths.projectAgents]) {
      if ((await readTextIfExists(candidate)) !== undefined) return true;
    }
    return false;
  }

  async import(context: AdapterContext, userId: string): Promise<ImportResult> {
    const paths = codexPaths(context);
    const builder = new ProfileBuilder(createEmptyProfile(userId), {
      sourceAgent: AGENT_ID,
      sourceDevice: context.device,
    });
    const warnings: AdapterWarning[] = [];
    const memories: MemoryDraft[] = [];
    const sources: string[] = [];

    const config = await this.readConfig(paths.configFile, warnings);
    if (config) {
      sources.push(paths.configFile);
      if (config.model) {
        const canonical = toCanonicalModel(config.model, 'openai');
        builder.model('coding', canonical).model('general', canonical);
      }
      if (config.model_reasoning_effort) {
        builder.customPreference('reasoningEffort', config.model_reasoning_effort);
      }

      for (const [name, server] of Object.entries(config.mcp_servers ?? {})) {
        const redacted = redactEnv(server.env, { file: paths.configFile, server: name });
        warnings.push(...redacted.warnings);
        builder.mcp({
          name,
          transport: server.url ? 'http' : 'stdio',
          ...(server.command ? { command: server.command } : {}),
          args: server.args ?? [],
          env: redacted.env,
          secretRefs: redacted.secretRefs,
          ...(server.url ? { url: server.url } : {}),
          enabled: true,
          scope: 'global',
        });
        for (const [variable, reference] of Object.entries(redacted.secretRefs)) {
          builder.secretRef(`${name}.${variable}`, reference);
        }
      }
    }

    for (const [file, ruleId, title, scope] of [
      [paths.globalAgents, GLOBAL_RULE_ID, 'Codex global instructions', 'global'],
      [paths.projectAgents, PROJECT_RULE_ID, 'Codex project instructions', 'project'],
    ] as const) {
      const text = await readTextIfExists(file);
      if (text === undefined) continue;
      sources.push(file);

      const managed = readManagedBlock(text);
      if (managed) builder.instructions(parseInstructions(managed));

      const authored = stripManagedBlock(text);
      if (!authored) continue;

      builder.rule({ id: ruleId, title, content: authored, scope, alwaysApply: true });
      builder.workspaceField('packageManager', inferWorkspaceHints(authored).packageManager);
      memories.push(
        ...extractMemories(authored, {
          source: file,
          sourceAgent: AGENT_ID,
          scope: scope === 'global' ? 'global' : 'project',
        }),
      );
    }

    const skills = await readSkillsDir(paths.skillsDir);
    for (const skill of skills) builder.skill(skill);
    if (skills.length > 0) sources.push(paths.skillsDir);

    return { profile: builder.build(), memories, warnings, sources };
  }

  async previewExport(
    context: AdapterContext,
    profile: UniversalProfile,
    memories: MemoryRecord[] = [],
  ): Promise<AgentConfigDiff> {
    const { changes, warnings } = await this.plan(context, profile, memories);
    return { agent: AGENT_ID, changes, warnings };
  }

  async export(
    context: AdapterContext,
    profile: UniversalProfile,
    memories: MemoryRecord[] = [],
  ): Promise<ExportResult> {
    const { changes, warnings } = await this.plan(context, profile, memories);
    const { written, skipped } = await applyPlan(changes, {
      dryRun: context.dryRun,
      write: writeFileAtomic,
    });
    return { agent: AGENT_ID, written, skipped, warnings };
  }

  async validate(context: AdapterContext): Promise<ValidationResult> {
    const paths = codexPaths(context);
    const issues: ValidationIssue[] = [];

    const text = await readTextIfExists(paths.configFile);
    if (text !== undefined) {
      try {
        parseToml(text);
      } catch (error) {
        issues.push({
          severity: 'error',
          message: (error as Error).message,
          file: paths.configFile,
        });
      }
    }

    if (!(await this.detect(context))) {
      issues.push({ severity: 'warning', message: 'no Codex configuration found' });
    }

    return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
  }

  private async readConfig(
    file: string,
    warnings: AdapterWarning[],
  ): Promise<CodexConfig | undefined> {
    const text = await readTextIfExists(file);
    if (text === undefined) return undefined;
    try {
      return parseToml(text) as CodexConfig;
    } catch (error) {
      warnings.push({
        severity: 'warn',
        message: `could not parse TOML: ${(error as Error).message}`,
        file,
      });
      return undefined;
    }
  }

  private async plan(
    context: AdapterContext,
    profile: UniversalProfile,
    memories: MemoryRecord[],
  ): Promise<{ changes: ConfigChange[]; warnings: AdapterWarning[] }> {
    const paths = codexPaths(context);
    const changes: ConfigChange[] = [];
    const warnings: AdapterWarning[] = [];

    const agentsBefore = await readTextIfExists(paths.globalAgents);
    changes.push(
      describeChange(
        paths.globalAgents,
        agentsBefore,
        applyManagedBlock(agentsBefore, renderInstructions(profile, memories)),
        'identity, preferences, workspace rules, and long-term memory',
      ),
    );

    const owned: Record<string, unknown> = {};
    const preferredModel = profile.models.coding ?? profile.models.general;
    const nativeModel = toNativeModel(preferredModel, { qualified: false, vendor: 'openai' });
    if (preferredModel && !nativeModel) {
      warnings.push({
        severity: 'info',
        message: `Codex cannot run ${preferredModel}; leaving its model setting unchanged`,
        file: paths.configFile,
      });
    }
    if (nativeModel) owned['model'] = nativeModel;

    const effort = profile.preferences.custom['reasoningEffort'];
    if (effort) owned['model_reasoning_effort'] = effort;

    const servers = profile.mcp.filter((server) => server.enabled);
    if (servers.length > 0) owned['mcp_servers'] = toNativeServers(servers);

    if (Object.keys(owned).length > 0) {
      const beforeText = await readTextIfExists(paths.configFile);
      let before: CodexConfig | undefined;
      if (beforeText !== undefined) {
        try {
          before = parseToml(beforeText) as CodexConfig;
        } catch (error) {
          warnings.push({
            severity: 'warn',
            message: `existing config.toml is not valid TOML and was left alone: ${(error as Error).message}`,
            file: paths.configFile,
          });
        }
      }

      if (beforeText === undefined || before !== undefined) {
        if (beforeText && /^\s*#/m.test(beforeText)) {
          warnings.push({
            severity: 'warn',
            message: 'rewriting config.toml preserves every setting but drops comments',
            file: paths.configFile,
          });
        }
        const after = mergePreserving(before, owned);
        changes.push(
          describeChange(
            paths.configFile,
            beforeText,
            `${stringifyToml(after)}\n`,
            describeConfig(nativeModel, servers.length),
          ),
        );
      }
    }

    for (const skill of profile.skills) {
      if (!skill.content) continue;
      const file = skillFilePath(paths.skillsDir, skill);
      const before = await readTextIfExists(file);
      changes.push(describeChange(file, before, renderSkillFile(skill), `skill "${skill.name}"`));
    }

    return { changes, warnings };
  }
}

function describeConfig(model: string | undefined, servers: number): string {
  const parts: string[] = [];
  if (model) parts.push(`model ${model}`);
  if (servers > 0) parts.push(`${servers} MCP server(s)`);
  return parts.join(', ') || 'configuration';
}

function toNativeServers(servers: McpServer[]): Record<string, CodexMcpServer> {
  const native: Record<string, CodexMcpServer> = {};
  for (const server of servers) {
    const env = expandEnv(server.env, server.secretRefs);
    native[server.name] = {
      ...(server.command ? { command: server.command } : {}),
      args: server.args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(server.url ? { url: server.url } : {}),
    };
  }
  return native;
}

export const codexAdapter = new CodexAdapter();
