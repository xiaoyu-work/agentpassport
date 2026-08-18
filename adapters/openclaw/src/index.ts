import {
  ADAPTER_API_VERSION,
  ProfileBuilder,
  applyManagedBlock,
  definePlugin,
  applyPlan,
  describeChange,
  expandEnv,
  inferWorkspaceHints,
  mergePreserving,
  parseInstructions,
  readJsonIfExists,
  readManagedBlock,
  readSkillsDir,
  readTextIfExists,
  redactEnv,
  renderInstructions,
  renderSkillFile,
  skillFilePath,
  stripManagedBlock,
  toCanonicalModel,
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
import {
  extractMemories,
  isRestorable,
  type MemoryDraft,
  type MemoryRecord,
} from '@agentpass/memory';
import { createEmptyProfile, type McpServer, type UniversalProfile } from '@agentpass/profile';
import {
  openclawPaths,
  primaryModel,
  type OpenClawConfig,
  type OpenClawMcpServer,
  type OpenClawTransport,
} from './paths.js';

const AGENT_ID = 'openclaw';
const AGENTS_RULE_ID = 'openclaw-agents-md';
const USER_RULE_ID = 'openclaw-user-md';

/**
 * OpenClaw adapter.
 *
 * OpenClaw already speaks a qualified `provider/model` reference, which makes it the
 * cheapest target for model preferences, but it splits identity across four workspace
 * markdown files (AGENTS.md, USER.md, MEMORY.md, SOUL.md) that no other agent has.
 */
export class OpenClawAdapter implements AgentAdapter {
  readonly id = AGENT_ID;
  readonly displayName = 'OpenClaw';

  async detect(context: AdapterContext): Promise<boolean> {
    const paths = openclawPaths(context);
    for (const candidate of [paths.configFile, paths.agentsFile, paths.userFile]) {
      if ((await readTextIfExists(candidate)) !== undefined) return true;
    }
    return false;
  }

  async import(context: AdapterContext, userId: string): Promise<ImportResult> {
    const paths = openclawPaths(context);
    const builder = new ProfileBuilder(createEmptyProfile(userId), {
      sourceAgent: AGENT_ID,
      sourceDevice: context.device,
    });
    const warnings: AdapterWarning[] = [];
    const memories: MemoryDraft[] = [];
    const sources: string[] = [];

    const config = await readJsonIfExists<OpenClawConfig>(paths.configFile);
    if (config) {
      sources.push(paths.configFile);

      const model = primaryModel(config.agents?.defaults?.model);
      if (model) {
        const canonical = toCanonicalModel(model, 'anthropic');
        builder.model('coding', canonical).model('general', canonical);
      }

      for (const [name, server] of Object.entries(config.mcp?.servers ?? {})) {
        const env = stringifyValues(server.env);
        const redacted = redactEnv(env, { file: paths.configFile, server: name });
        warnings.push(...redacted.warnings);
        builder.mcp({
          name,
          transport:
            server.transport === 'sse'
              ? 'sse'
              : server.transport === 'streamable-http'
                ? 'http'
                : 'stdio',
          ...(server.command ? { command: server.command } : {}),
          args: server.args ?? [],
          env: redacted.env,
          secretRefs: redacted.secretRefs,
          ...(server.url ? { url: server.url } : {}),
          headers: stringifyValues(server.headers),
          enabled: server.enabled !== false,
          scope: 'global',
        });
        for (const [variable, reference] of Object.entries(redacted.secretRefs)) {
          builder.secretRef(`${name}.${variable}`, reference);
        }
      }

      for (const [name, entry] of Object.entries(config.skills?.entries ?? {})) {
        builder.skill({ name, enabled: entry.enabled !== false, source: 'local' });
      }
    }

    for (const [file, ruleId, title] of [
      [paths.agentsFile, AGENTS_RULE_ID, 'OpenClaw agent instructions'],
      [paths.userFile, USER_RULE_ID, 'OpenClaw user profile'],
    ] as const) {
      const text = await readTextIfExists(file);
      if (text === undefined) continue;
      sources.push(file);

      const managed = readManagedBlock(text);
      if (managed) builder.instructions(parseInstructions(managed));

      const authored = stripManagedBlock(text);
      if (!authored) continue;

      builder.rule({ id: ruleId, title, content: authored, scope: 'global', alwaysApply: true });
      builder.workspaceField('packageManager', inferWorkspaceHints(authored).packageManager);
      memories.push(
        ...extractMemories(authored, { source: file, sourceAgent: AGENT_ID, scope: 'global' }),
      );
    }

    // MEMORY.md is OpenClaw's long-term memory file, so its contents are memory candidates
    // rather than instructions and never become a workspace rule.
    const memoryText = await readTextIfExists(paths.memoryFile);
    if (memoryText !== undefined) {
      sources.push(paths.memoryFile);
      const authored = stripManagedBlock(memoryText);
      if (authored) {
        memories.push(
          ...extractMemories(authored, {
            source: paths.memoryFile,
            sourceAgent: AGENT_ID,
            scope: 'global',
          }),
        );
      }
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
    const paths = openclawPaths(context);
    const issues: ValidationIssue[] = [];

    const text = await readTextIfExists(paths.configFile);
    if (text !== undefined) {
      try {
        JSON.parse(text);
      } catch (error) {
        issues.push({
          severity: 'error',
          message: (error as Error).message,
          file: paths.configFile,
        });
      }
    }

    if (!(await this.detect(context))) {
      issues.push({ severity: 'warning', message: 'no OpenClaw configuration found' });
    }

    return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
  }

  private async plan(
    context: AdapterContext,
    profile: UniversalProfile,
    memories: MemoryRecord[],
  ): Promise<{ changes: ConfigChange[]; warnings: AdapterWarning[] }> {
    const paths = openclawPaths(context);
    const changes: ConfigChange[] = [];
    const warnings: AdapterWarning[] = [];

    const agentsBefore = await readTextIfExists(paths.agentsFile);
    changes.push(
      describeChange(
        paths.agentsFile,
        agentsBefore,
        applyManagedBlock(agentsBefore, renderInstructions(profile)),
        'identity, preferences, and workspace rules',
      ),
    );

    const restorable = memories.filter(isRestorable);
    if (restorable.length > 0) {
      const memoryBefore = await readTextIfExists(paths.memoryFile);
      const body = ['# Long-term memory', '', ...restorable.map((m) => `- ${m.content}`)].join(
        '\n',
      );
      changes.push(
        describeChange(
          paths.memoryFile,
          memoryBefore,
          applyManagedBlock(memoryBefore, body),
          `${restorable.length} long-term memor${restorable.length === 1 ? 'y' : 'ies'}`,
        ),
      );
    }

    const owned: Record<string, unknown> = {};

    const preferredModel = profile.models.coding ?? profile.models.general;
    if (preferredModel) {
      owned['agents'] = { defaults: { model: preferredModel } };
    }

    const servers = profile.mcp.filter((server) => server.enabled);
    if (servers.length > 0) {
      owned['mcp'] = { servers: toNativeServers(servers) };
    }

    const skillEntries = Object.fromEntries(
      profile.skills.map((skill) => [skill.name, { enabled: skill.enabled }]),
    );
    if (Object.keys(skillEntries).length > 0) {
      owned['skills'] = { entries: skillEntries };
    }

    if (Object.keys(owned).length > 0) {
      const before = await readJsonIfExists<OpenClawConfig>(paths.configFile);
      const after = mergePreserving(before, owned);
      changes.push(
        describeChange(
          paths.configFile,
          before ? serialize(before) : undefined,
          serialize(after),
          describeConfig(preferredModel, servers.length, Object.keys(skillEntries).length),
        ),
      );
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

function describeConfig(model: string | undefined, servers: number, skills: number): string {
  const parts: string[] = [];
  if (model) parts.push(`model ${model}`);
  if (servers > 0) parts.push(`${servers} MCP server(s)`);
  if (skills > 0) parts.push(`${skills} skill(s)`);
  return parts.join(', ') || 'configuration';
}

function toNativeServers(servers: McpServer[]): Record<string, OpenClawMcpServer> {
  const native: Record<string, OpenClawMcpServer> = {};
  for (const server of servers) {
    const env = expandEnv(server.env, server.secretRefs);
    const transport: OpenClawTransport =
      server.transport === 'sse'
        ? 'sse'
        : server.transport === 'http'
          ? 'streamable-http'
          : 'stdio';
    native[server.name] = {
      enabled: server.enabled,
      transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args.length > 0 ? { args: server.args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    };
  }
  return native;
}

/** OpenClaw permits numbers and booleans in env and header maps; the profile stores strings. */
function stringifyValues(
  source: Record<string, string | number | boolean> | undefined,
): Record<string, string> {
  if (!source) return {};
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, String(value)]));
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const openclawAdapter = new OpenClawAdapter();

export const plugin = definePlugin({
  apiVersion: ADAPTER_API_VERSION,
  id: AGENT_ID,
  displayName: 'OpenClaw',
  version: '0.1.0',
  create: () => new OpenClawAdapter(),
});

export default plugin;
export * from './paths.js';
