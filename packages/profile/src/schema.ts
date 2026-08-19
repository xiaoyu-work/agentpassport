import { z } from 'zod';

/**
 * Field-level change metadata. Every mutable path in a profile carries one of
 * these so that two devices editing different fields never conflict, and two
 * devices editing the *same* field conflict loudly instead of silently.
 */
export const FieldMetaSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.string(),
  sourceDevice: z.string(),
  sourceAgent: z.string(),
});
export type FieldMeta = z.infer<typeof FieldMetaSchema>;

export const IdentitySchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().optional(),
  email: z.string().optional(),
  pronouns: z.string().optional(),
  bio: z.string().optional(),
});
export type Identity = z.infer<typeof IdentitySchema>;

export const CommunicationStyleSchema = z.enum(['concise', 'balanced', 'detailed']);
export type CommunicationStyle = z.infer<typeof CommunicationStyleSchema>;

export const PreferencesSchema = z.object({
  language: z.string().optional(),
  communicationStyle: CommunicationStyleSchema.optional(),
  timezone: z.string().optional(),
  /** Free-form preferences an adapter surfaced but the schema does not model. */
  custom: z.record(z.string(), z.string()).default({}),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

/**
 * Model references are vendor-qualified and agent-neutral: `anthropic/claude-sonnet-4-6`,
 * `openai/gpt-5.5`. Adapters translate to and from each agent's native spelling.
 */
export const ModelPreferencesSchema = z.object({
  coding: z.string().optional(),
  general: z.string().optional(),
  reasoning: z.string().optional(),
  fast: z.string().optional(),
  providerOrder: z.array(z.string()).default([]),
});
export type ModelPreferences = z.infer<typeof ModelPreferencesSchema>;

export const McpTransportSchema = z.enum(['stdio', 'sse', 'http']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerSchema = z.object({
  name: z.string().min(1),
  transport: McpTransportSchema.default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  /**
   * Non-sensitive environment only. Anything that looks like credential material is
   * moved to `secretRefs` during import and never persisted here.
   */
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  /** Environment variable name -> secret reference URI, resolved at launch time. */
  secretRefs: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
  scope: z.enum(['global', 'project']).default('global'),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const SkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  source: z.enum(['builtin', 'local', 'registry']).default('local'),
  enabled: z.boolean().default(true),
  /** Portable SKILL.md body, when the skill is small enough to travel with the profile. */
  content: z.string().optional(),
});
export type Skill = z.infer<typeof SkillSchema>;

/**
 * A workspace rule is the agent-neutral form of CLAUDE.md, AGENTS.md, and
 * `.cursor/rules/*.mdc`. `alwaysApply` plus an empty `appliesTo` is a global
 * instruction file; a populated `appliesTo` is a path-scoped rule.
 */
export const WorkspaceRuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(''),
  content: z.string().default(''),
  scope: z.enum(['global', 'project']).default('global'),
  appliesTo: z.array(z.string()).default([]),
  alwaysApply: z.boolean().default(true),
});
export type WorkspaceRule = z.infer<typeof WorkspaceRuleSchema>;

export const ProjectSchema = z.object({
  name: z.string().min(1),
  path: z.string().optional(),
  description: z.string().optional(),
  repository: z.string().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const WorkspaceSchema = z.object({
  codingStyle: z.string().optional(),
  packageManager: z.string().optional(),
  testCommand: z.string().optional(),
  rules: z.array(WorkspaceRuleSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  custom: z.record(z.string(), z.string()).default({}),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const MemoryConfigSchema = z.object({
  provider: z.enum(['mem0', 'local']).default('local'),
  namespace: z.string().default('personal'),
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/**
 * A secret reference URI. Agent Passport stores the *pointer*, never the material:
 * `op://Private/openai/credential`, `infisical://proj/prod/OPENAI_API_KEY`,
 * `env://OPENAI_API_KEY`.
 */
export const SECRET_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9+.-]*:\/\/\S+$/i;

export const SecretsConfigSchema = z.object({
  provider: z.enum(['1password', 'infisical', 'env', 'none']).default('none'),
  references: z
    .record(z.string(), z.string().regex(SECRET_REFERENCE_PATTERN, 'must be a reference URI'))
    .default({}),
});
export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;

export const ArtifactKindSchema = z.enum([
  'instructions',
  'settings',
  'mcp',
  'skill',
  'rule',
  'memory',
  'other',
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/**
 * A verbatim copy of a file Agent Passport read from an agent.
 *
 * The normalized profile above is a translation, and every translation loses something:
 * it can only carry the fields this schema models, so an agent's permissions, hooks, or
 * status line would vanish on the trip to a new machine. Keeping the original bytes as
 * well means a same-agent restore is faithful, while the normalized form is what makes a
 * cross-agent restore possible at all. Neither replaces the other.
 *
 * Content is scrubbed of credential material before it is stored, so a raw capture never
 * becomes a new place a token lives.
 */
export const ArtifactSchema = z.object({
  agent: z.string().min(1),
  /** Portable location: `~/`-relative for user files, `./`-relative for project files. */
  path: z.string().min(1),
  kind: ArtifactKindSchema.default('other'),
  scope: z.enum(['global', 'project']).default('global'),
  content: z.string(),
  bytes: z.number().int().nonnegative().default(0),
  /** True when credential material was replaced during capture. */
  redacted: z.boolean().default(false),
  capturedAt: z.string().default(() => new Date().toISOString()),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const PROFILE_SCHEMA_VERSION = 1;

export const UniversalProfileSchema = z.object({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION).default(PROFILE_SCHEMA_VERSION),
  identity: IdentitySchema,
  preferences: PreferencesSchema.prefault({}),
  models: ModelPreferencesSchema.prefault({}),
  skills: z.array(SkillSchema).default([]),
  mcp: z.array(McpServerSchema).default([]),
  workspace: WorkspaceSchema.prefault({}),
  memory: MemoryConfigSchema.prefault({}),
  secrets: SecretsConfigSchema.prefault({}),
  /** Verbatim originals, so a same-agent restore loses nothing this schema cannot model. */
  artifacts: z.array(ArtifactSchema).default([]),
  /** Path (see `paths.ts`) -> change metadata. */
  meta: z.record(z.string(), FieldMetaSchema).default({}),
  revision: z.number().int().nonnegative().default(0),
  updatedAt: z.string().default(() => new Date().toISOString()),
});
export type UniversalProfile = z.infer<typeof UniversalProfileSchema>;

export function parseProfile(input: unknown): UniversalProfile {
  return UniversalProfileSchema.parse(input);
}

export function safeParseProfile(
  input: unknown,
): { ok: true; profile: UniversalProfile } | { ok: false; errors: string[] } {
  const result = UniversalProfileSchema.safeParse(input);
  if (result.success) return { ok: true, profile: result.data };
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    ),
  };
}

export function createEmptyProfile(userId: string): UniversalProfile {
  return UniversalProfileSchema.parse({ identity: { userId } });
}
