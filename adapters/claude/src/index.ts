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
import {
  claudePaths,
  type ClaudeGlobalJson,
  type ClaudeMcpFile,
  type ClaudeMcpServer,
  type ClaudeSettings,
} from './paths.js';

const AGENT_ID = 'claude';
const USER_RULE_ID = 'claude-user-memory';
const PROJECT_RULE_ID = 'claude-project-memory';

/**
 * Claude Code adapter.
 *
 * Claude spreads its state across four places that do not agree on format: prose in
 * CLAUDE.md, settings in `~/.claude/settings.json`, MCP servers in `~/.claude.json`
 * (keyed by `type`, not `transport`), and project MCP servers in `.mcp.json`. Collapsing
 * those into one profile — and putting them back — is the whole job.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = AGENT_ID;
  readonly displayName = 'Claude Code';

  async detect(context: AdapterContext): Promise<boolean> {
    const paths = claudePaths(context);
    const candidates = [
      paths.userSettings,
      paths.userMemory,
      paths.globalJson,
      paths.projectMemory,
      paths.projectMcp,
    ];
    for (const candidate of candidates) {
      if ((await readTextIfExists(candidate)) !== undefined) return true;
    }
    return false;
  }

  async import(context: AdapterContext, userId: string): Promise<ImportResult> {
    const paths = claudePaths(context);
    const builder = new ProfileBuilder(createEmptyProfile(userId), {
      sourceAgent: AGENT_ID,
      sourceDevice: context.device,
    });
    const warnings: AdapterWarning[] = [];
    const memories: MemoryDraft[] = [];
    const sources: string[] = [];

    const settings = await readJsonIfExists<ClaudeSettings>(paths.userSettings);
    if (settings) {
      sources.push(paths.userSettings);
      if (settings.model) {
        const canonical = toCanonicalModel(settings.model, 'anthropic');
        builder.model('coding', canonical).model('general', canonical);
      }
      if (settings.outputStyle) builder.customPreference('outputStyle', settings.outputStyle);
    }

    for (const [file, ruleId, title, scope] of [
      [paths.userMemory, USER_RULE_ID, 'Claude Code user memory', 'global'],
      [paths.projectMemory, PROJECT_RULE_ID, 'Claude Code project memory', 'project'],
      [paths.projectMemoryAlt, PROJECT_RULE_ID, 'Claude Code project memory', 'project'],
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

    const global = await readJsonIfExists<ClaudeGlobalJson>(paths.globalJson);
    if (global) {
      sources.push(paths.globalJson);
      this.absorbServers(builder, warnings, global.mcpServers, 'global', paths.globalJson);
      const projectEntry = global.projects?.[context.cwd];
      this.absorbServers(builder, warnings, projectEntry?.mcpServers, 'project', paths.globalJson);
    }

    const projectMcp = await readJsonIfExists<ClaudeMcpFile>(paths.projectMcp);
    if (projectMcp) {
      sources.push(paths.projectMcp);
      this.absorbServers(builder, warnings, projectMcp.mcpServers, 'project', paths.projectMcp);
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
    const paths = claudePaths(context);
    const issues: ValidationIssue[] = [];

    for (const file of [paths.userSettings, paths.globalJson, paths.projectMcp]) {
      const text = await readTextIfExists(file);
      if (text === undefined) continue;
      try {
        JSON.parse(text);
      } catch (error) {
        issues.push({ severity: 'error', message: (error as Error).message, file });
      }
    }

    if (!(await this.detect(context))) {
      issues.push({ severity: 'warning', message: 'no Claude Code configuration found' });
    }

    return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
  }

  private absorbServers(
    builder: ProfileBuilder,
    warnings: AdapterWarning[],
    servers: Record<string, ClaudeMcpServer> | undefined,
    scope: 'global' | 'project',
    file: string,
  ): void {
    for (const [name, server] of Object.entries(servers ?? {})) {
      const redacted = redactEnv(server.env, { file, server: name });
      warnings.push(...redacted.warnings);
      builder.mcp({
        name,
        transport: server.type === 'sse' ? 'sse' : server.type === 'http' ? 'http' : 'stdio',
        ...(server.command ? { command: server.command } : {}),
        args: server.args ?? [],
        env: redacted.env,
        secretRefs: redacted.secretRefs,
        ...(server.url ? { url: server.url } : {}),
        headers: server.headers ?? {},
        enabled: true,
        scope,
      });
      for (const [variable, reference] of Object.entries(redacted.secretRefs)) {
        builder.secretRef(`${name}.${variable}`, reference);
      }
    }
  }

  private async plan(
    context: AdapterContext,
    profile: UniversalProfile,
    memories: MemoryRecord[],
  ): Promise<{ changes: ConfigChange[]; warnings: AdapterWarning[] }> {
    const paths = claudePaths(context);
    const changes: ConfigChange[] = [];
    const warnings: AdapterWarning[] = [];

    const memoryBefore = await readTextIfExists(paths.userMemory);
    changes.push(
      describeChange(
        paths.userMemory,
        memoryBefore,
        applyManagedBlock(memoryBefore, renderInstructions(profile, memories)),
        'identity, preferences, workspace rules, and long-term memory',
      ),
    );

    const preferredModel = profile.models.coding ?? profile.models.general;
    const nativeModel = toNativeModel(preferredModel, { qualified: false, vendor: 'anthropic' });
    if (preferredModel && !nativeModel) {
      warnings.push({
        severity: 'info',
        message: `Claude Code cannot run ${preferredModel}; leaving its model setting unchanged`,
        file: paths.userSettings,
      });
    }
    if (nativeModel) {
      const settingsBefore = await readJsonIfExists<ClaudeSettings>(paths.userSettings);
      const settingsAfter = mergePreserving(settingsBefore, { model: nativeModel });
      changes.push(
        describeChange(
          paths.userSettings,
          settingsBefore ? serialize(settingsBefore) : undefined,
          serialize(settingsAfter),
          `model preference (${nativeModel})`,
        ),
      );
    }

    const globalServers = profile.mcp.filter(
      (server) => server.scope === 'global' && server.enabled,
    );
    if (globalServers.length > 0) {
      const before = await readJsonIfExists<ClaudeGlobalJson>(paths.globalJson);
      const after = mergePreserving(before, { mcpServers: toNativeServers(globalServers) });
      changes.push(
        describeChange(
          paths.globalJson,
          before ? serialize(before) : undefined,
          serialize(after),
          `${globalServers.length} MCP server(s)`,
        ),
      );
    }

    const projectServers = profile.mcp.filter(
      (server) => server.scope === 'project' && server.enabled,
    );
    if (projectServers.length > 0) {
      const before = await readJsonIfExists<ClaudeMcpFile>(paths.projectMcp);
      const after = mergePreserving(before, { mcpServers: toNativeServers(projectServers) });
      changes.push(
        describeChange(
          paths.projectMcp,
          before ? serialize(before) : undefined,
          serialize(after),
          `${projectServers.length} project MCP server(s)`,
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

function toNativeServers(servers: McpServer[]): Record<string, ClaudeMcpServer> {
  const native: Record<string, ClaudeMcpServer> = {};
  for (const server of servers) {
    const env = expandEnv(server.env, server.secretRefs);
    native[server.name] = {
      type: server.transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args.length > 0 ? { args: server.args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    };
  }
  return native;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const claudeAdapter = new ClaudeAdapter();

export const plugin = definePlugin({
  apiVersion: ADAPTER_API_VERSION,
  id: AGENT_ID,
  displayName: 'Claude Code',
  version: '0.1.0',
  create: () => new ClaudeAdapter(),
});

export default plugin;
export * from './paths.js';
