import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ADAPTER_API_VERSION,
  ProfileBuilder,
  applyManagedBlock,
  applyPlan,
  captureArtifact,
  definePlugin,
  describeChange,
  expandEnv,
  inferWorkspaceHints,
  mergePreserving,
  missingArtifacts,
  parseFrontmatter,
  parseInstructions,
  readJsonIfExists,
  readManagedBlock,
  readTextIfExists,
  restoreArtifacts,
  redactEnv,
  renderFrontmatter,
  renderInstructions,
  stripManagedBlock,
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
} from '@agentpassport/adapter-sdk';
import { extractMemories, type MemoryDraft, type MemoryRecord } from '@agentpassport/memory';
import {
  createEmptyProfile,
  type McpServer,
  type UniversalProfile,
  type WorkspaceRule,
} from '@agentpassport/profile';

const AGENT_ID = 'cursor';
const PASSPORT_RULE_FILE = 'agent-passport.mdc';
const AGENTS_RULE_ID = 'cursor-agents-md';

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

/**
 * Files that belong in a Cursor identity snapshot. Global MCP only —
 * project rules and .cursor/rules live in the project repo.
 */
export function snapshotEntries(paths: CursorPaths): string[] {
  return [paths.globalMcp];
}

interface CursorMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface CursorMcpFile {
  mcpServers?: Record<string, CursorMcpServer>;
  [key: string]: unknown;
}

/**
 * Cursor adapter.
 *
 * Cursor is the one target that is project-first: rules live in `.cursor/rules/*.mdc` with
 * frontmatter that decides *when* a rule loads. That makes `alwaysApply` and `globs` the
 * natural home for the profile's `alwaysApply` and `appliesTo`, which no other agent can
 * express.
 */
export class CursorAdapter implements AgentAdapter {
  readonly id = AGENT_ID;
  readonly displayName = 'Cursor';

  async detect(context: AdapterContext): Promise<boolean> {
    const paths = cursorPaths(context);
    for (const candidate of [paths.passportRule, paths.projectMcp, paths.globalMcp]) {
      if ((await readTextIfExists(candidate)) !== undefined) return true;
    }
    try {
      const entries = await readdir(paths.rulesDir);
      return entries.some((entry) => entry.endsWith('.mdc'));
    } catch {
      return false;
    }
  }

  async import(context: AdapterContext, userId: string): Promise<ImportResult> {
    const paths = cursorPaths(context);
    const builder = new ProfileBuilder(createEmptyProfile(userId), {
      sourceAgent: AGENT_ID,
      sourceDevice: context.device,
    });
    const warnings: AdapterWarning[] = [];
    const memories: MemoryDraft[] = [];
    const sources: string[] = [];

    let ruleFiles: string[] = [];
    try {
      ruleFiles = (await readdir(paths.rulesDir)).filter((file) => file.endsWith('.mdc')).sort();
    } catch {
      ruleFiles = [];
    }

    for (const file of ruleFiles) {
      const full = join(paths.rulesDir, file);
      const text = await readTextIfExists(full);
      if (text === undefined) continue;
      sources.push(full);

      // Rules are Cursor's principal configuration, so keep each one verbatim as well as
      // in normalized form; frontmatter this schema does not model would be lost otherwise.
      const captured = await captureArtifact(context, full, {
        agent: AGENT_ID,
        kind: 'rule',
        scope: 'project',
      });
      warnings.push(...captured.warnings);
      if (captured.artifact) builder.artifact(captured.artifact);

      const { data, body } = parseFrontmatter(text);

      if (file === PASSPORT_RULE_FILE) {
        const managed = readManagedBlock(body);
        if (managed) builder.instructions(parseInstructions(managed));
        continue;
      }

      const globs = typeof data['globs'] === 'string' ? splitGlobs(data['globs']) : [];
      const content = body.trim();
      if (!content) continue;

      builder.rule({
        id: file.replace(/\.mdc$/, ''),
        title: typeof data['description'] === 'string' ? data['description'] : file,
        content,
        scope: 'project',
        appliesTo: globs,
        alwaysApply: data['alwaysApply'] === true,
      });
      builder.workspaceField('packageManager', inferWorkspaceHints(content).packageManager);
      memories.push(
        ...extractMemories(content, { source: full, sourceAgent: AGENT_ID, scope: 'project' }),
      );
    }

    const agentsText = await readTextIfExists(paths.agentsFile);
    if (agentsText !== undefined) {
      sources.push(paths.agentsFile);
      const managed = readManagedBlock(agentsText);
      if (managed) builder.instructions(parseInstructions(managed));
      const authored = stripManagedBlock(agentsText);
      if (authored) {
        builder.rule({
          id: AGENTS_RULE_ID,
          title: 'Cursor project instructions',
          content: authored,
          scope: 'project',
          alwaysApply: true,
        });
        memories.push(
          ...extractMemories(authored, {
            source: paths.agentsFile,
            sourceAgent: AGENT_ID,
            scope: 'project',
          }),
        );
      }
    }

    for (const [file, scope] of [
      [paths.globalMcp, 'global'],
      [paths.projectMcp, 'project'],
    ] as const) {
      const mcp = await readJsonIfExists<CursorMcpFile>(file);
      if (!mcp) continue;
      sources.push(file);
      for (const [name, server] of Object.entries(mcp.mcpServers ?? {})) {
        const redacted = redactEnv(server.env, { file, server: name });
        warnings.push(...redacted.warnings);
        builder.mcp({
          name,
          transport: server.url ? 'http' : 'stdio',
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

    // Keep the originals too. The normalized profile cannot represent every setting an
    // agent supports, and a restore onto a fresh machine would silently drop the rest.
    for (const [file, kind, scope] of [
      [paths.projectMcp, 'mcp', 'project'],
      [paths.globalMcp, 'mcp', 'global'],
      [paths.agentsFile, 'instructions', 'project'],
    ] as const) {
      const captured = await captureArtifact(context, file, { agent: AGENT_ID, kind, scope });
      warnings.push(...captured.warnings);
      if (captured.artifact) builder.artifact(captured.artifact);
    }

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
    const restored = await restoreArtifacts(context, profile.artifacts, AGENT_ID);

    const { changes, warnings } = await this.plan(context, profile, memories);
    const { written, skipped } = await applyPlan(changes, {
      dryRun: context.dryRun,
      write: writeFileAtomic,
    });
    return {
      agent: AGENT_ID,
      written: [...restored.written, ...written],
      skipped: [...restored.skipped, ...skipped],
      warnings,
    };
  }

  async validate(context: AdapterContext): Promise<ValidationResult> {
    const paths = cursorPaths(context);
    const issues: ValidationIssue[] = [];

    for (const file of [paths.projectMcp, paths.globalMcp]) {
      const text = await readTextIfExists(file);
      if (text === undefined) continue;
      try {
        JSON.parse(text);
      } catch (error) {
        issues.push({ severity: 'error', message: (error as Error).message, file });
      }
    }

    if (!(await this.detect(context))) {
      issues.push({ severity: 'warning', message: 'no Cursor configuration found' });
    }

    return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
  }

  private async plan(
    context: AdapterContext,
    profile: UniversalProfile,
    memories: MemoryRecord[],
  ): Promise<{ changes: ConfigChange[]; warnings: AdapterWarning[] }> {
    const paths = cursorPaths(context);
    const changes: ConfigChange[] = [];
    const warnings: AdapterWarning[] = [];

    for (const { artifact, target } of await missingArtifacts(
      context,
      profile.artifacts,
      AGENT_ID,
    )) {
      changes.push(
        describeChange(target, undefined, artifact.content, `original ${artifact.kind} file`),
      );
    }

    const passportBefore = await readTextIfExists(paths.passportRule);
    const passportBody = applyManagedBlock(
      passportBefore ? parseFrontmatter(passportBefore).body : undefined,
      renderInstructions(profile, memories),
    );
    changes.push(
      describeChange(
        paths.passportRule,
        passportBefore,
        renderFrontmatter(
          { description: 'Agent Passport identity, preferences, and memory', alwaysApply: true },
          passportBody,
        ),
        'identity, preferences, and long-term memory',
      ),
    );

    for (const rule of profile.workspace.rules) {
      if (!rule.content.trim()) continue;
      const file = join(paths.rulesDir, `${rule.id}.mdc`);
      const before = await readTextIfExists(file);
      changes.push(
        describeChange(file, before, renderRule(rule), `rule "${rule.title || rule.id}"`),
      );
    }

    const servers = profile.mcp.filter((server) => server.enabled);
    if (servers.length > 0) {
      const before = await readJsonIfExists<CursorMcpFile>(paths.projectMcp);
      const after = mergePreserving(before, { mcpServers: toNativeServers(servers) });
      changes.push(
        describeChange(
          paths.projectMcp,
          before ? serialize(before) : undefined,
          serialize(after),
          `${servers.length} MCP server(s)`,
        ),
      );
    }

    if (profile.models.coding || profile.models.general) {
      warnings.push({
        severity: 'info',
        message: 'Cursor selects models in its UI, so the model preference was not written',
      });
    }

    return { changes, warnings };
  }
}

/**
 * Frontmatter decides when Cursor loads a rule: `alwaysApply` for identity, `globs` for
 * path-scoped rules. Emitting neither would make the rule reachable only by @-mention.
 */
function renderRule(rule: WorkspaceRule): string {
  const data: Record<string, unknown> = {};
  if (rule.title) data['description'] = rule.title;
  if (rule.appliesTo.length > 0) data['globs'] = rule.appliesTo.join(', ');
  data['alwaysApply'] = rule.alwaysApply && rule.appliesTo.length === 0;
  return renderFrontmatter(data, rule.content);
}

function splitGlobs(value: string): string[] {
  return value
    .split(',')
    .map((glob) => glob.trim())
    .filter(Boolean);
}

function toNativeServers(servers: McpServer[]): Record<string, CursorMcpServer> {
  const native: Record<string, CursorMcpServer> = {};
  for (const server of servers) {
    const env = expandEnv(server.env, server.secretRefs);
    native[server.name] = {
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

export const cursorAdapter = new CursorAdapter();

export const plugin = definePlugin({
  apiVersion: ADAPTER_API_VERSION,
  id: AGENT_ID,
  displayName: 'Cursor',
  version: '0.1.0',
  create: () => new CursorAdapter(),
});

export default plugin;
