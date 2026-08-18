import {
  ProfilePaths,
  stampField,
  type Identity,
  type McpServer,
  type ModelPreferences,
  type Preferences,
  type Project,
  type Skill,
  type UniversalProfile,
  type Workspace,
  type WorkspaceRule,
} from '@agentpass/profile';
import { McpServerSchema, SkillSchema, WorkspaceRuleSchema } from '@agentpass/profile';
import type { ParsedInstructions } from './instructions.js';

type IdentityField = Exclude<keyof Identity, 'userId'>;
type PreferenceField = 'language' | 'communicationStyle' | 'timezone';
type ModelRole = Exclude<keyof ModelPreferences, 'providerOrder'>;
type WorkspaceField = 'codingStyle' | 'packageManager' | 'testCommand';

/**
 * Accumulates adapter findings into a profile, stamping change metadata as it goes.
 *
 * Every write goes through here so no adapter can add a field without recording where it
 * came from. Without that metadata the sync engine has no basis to resolve a conflict and
 * would fall back to guessing.
 */
export class ProfileBuilder {
  private readonly sourceAgent: string;
  private readonly sourceDevice: string;

  constructor(
    private readonly profile: UniversalProfile,
    options: { sourceAgent: string; sourceDevice: string },
  ) {
    this.sourceAgent = options.sourceAgent;
    this.sourceDevice = options.sourceDevice;
  }

  private stamp(path: string): void {
    stampField(this.profile, path, {
      sourceAgent: this.sourceAgent,
      sourceDevice: this.sourceDevice,
    });
  }

  identity(field: IdentityField, value: string | undefined): this {
    if (!value) return this;
    this.profile.identity[field] = value;
    this.stamp(ProfilePaths.identity(field));
    return this;
  }

  preference(field: PreferenceField, value: string | undefined): this {
    if (!value) return this;
    (this.profile.preferences as Record<string, unknown>)[field] = value;
    this.stamp(ProfilePaths.preference(field));
    return this;
  }

  customPreference(key: string, value: string | undefined): this {
    if (!value) return this;
    this.profile.preferences.custom[key] = value;
    this.stamp(ProfilePaths.customPreference(key));
    return this;
  }

  model(role: ModelRole, value: string | undefined): this {
    if (!value) return this;
    this.profile.models[role] = value;
    this.stamp(ProfilePaths.model(role));
    return this;
  }

  workspaceField(field: WorkspaceField, value: string | undefined): this {
    if (!value) return this;
    (this.profile.workspace as Record<string, unknown>)[field] = value;
    this.stamp(ProfilePaths.workspace(field));
    return this;
  }

  workspaceCustom(key: string, value: string | undefined): this {
    if (!value) return this;
    this.profile.workspace.custom[key] = value;
    this.stamp(ProfilePaths.workspace(`custom.${key}`));
    return this;
  }

  mcp(server: Partial<McpServer> & { name: string }): this {
    const parsed = McpServerSchema.parse(server);
    upsert(this.profile.mcp, parsed, (candidate) => candidate.name === parsed.name);
    this.stamp(ProfilePaths.mcp(parsed.name));
    return this;
  }

  skill(skill: Partial<Skill> & { name: string }): this {
    const parsed = SkillSchema.parse(skill);
    upsert(this.profile.skills, parsed, (candidate) => candidate.name === parsed.name);
    this.stamp(ProfilePaths.skill(parsed.name));
    return this;
  }

  rule(rule: Partial<WorkspaceRule> & { id: string }): this {
    const parsed = WorkspaceRuleSchema.parse(rule);
    if (!parsed.content.trim()) return this;
    upsert(this.profile.workspace.rules, parsed, (candidate) => candidate.id === parsed.id);
    this.stamp(ProfilePaths.rule(parsed.id));
    return this;
  }

  project(project: Project): this {
    upsert(
      this.profile.workspace.projects,
      project,
      (candidate) => candidate.name === project.name,
    );
    this.stamp(ProfilePaths.project(project.name));
    return this;
  }

  secretRef(name: string, reference: string): this {
    this.profile.secrets.references[name] = reference;
    this.stamp(ProfilePaths.secretRef(name));
    return this;
  }

  /** Apply everything recovered from a managed instruction block. */
  instructions(parsed: ParsedInstructions): this {
    this.identity('displayName', parsed.displayName)
      .identity('email', parsed.email)
      .identity('pronouns', parsed.pronouns)
      .identity('bio', parsed.bio)
      .preference('timezone', parsed.timezone)
      .preference('language', parsed.language)
      .preference('communicationStyle', parsed.communicationStyle)
      .workspaceField('packageManager', parsed.packageManager)
      .workspaceField('codingStyle', parsed.codingStyle)
      .workspaceField('testCommand', parsed.testCommand);

    for (const [key, value] of Object.entries(parsed.custom)) this.workspaceCustom(key, value);
    for (const project of parsed.projects) this.project(project);
    for (const rule of parsed.rules) this.rule({ ...rule, scope: 'global' });
    return this;
  }

  build(): UniversalProfile {
    return this.profile;
  }
}

export type { Preferences, Workspace };

function upsert<T>(list: T[], item: T, matches: (candidate: T) => boolean): void {
  const index = list.findIndex(matches);
  if (index === -1) list.push(item);
  else list[index] = item;
}
