import {
  ProfilePaths,
  canonicalStringify,
  type Artifact,
  type McpServer,
  type Project,
  type Skill,
  type UniversalProfile,
  type WorkspaceRule,
} from '@agentpassport/profile';

/**
 * One addressable, independently mergeable unit of a profile.
 *
 * Carrying `apply`/`remove` with each entry means the merge engine never needs to know
 * the shape of the profile. Adding a field to the schema means adding one flattener here,
 * and diff, merge, and conflict reporting all pick it up for free.
 */
export interface FlatEntry {
  path: string;
  /** Noun shown to the user, e.g. `MCP` or `preference`. */
  kind: string;
  /** Identifier shown after the kind, e.g. `github`. */
  label: string;
  /** Short rendering of the value for diff output. */
  summary: string;
  /** Canonical comparison key. Equal strings mean equal values. */
  canonical: string;
  apply(target: UniversalProfile): void;
  remove(target: UniversalProfile): void;
}

const MAX_SUMMARY = 72;

function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_SUMMARY ? collapsed : `${collapsed.slice(0, MAX_SUMMARY - 1)}…`;
}

function scalarEntry(
  path: string,
  kind: string,
  label: string,
  value: string,
  write: (target: UniversalProfile, next: string | undefined) => void,
): FlatEntry {
  return {
    path,
    kind,
    label,
    summary: truncate(value),
    canonical: canonicalStringify(value),
    apply: (target) => write(target, value),
    remove: (target) => write(target, undefined),
  };
}

function collectionEntry<T extends object>(
  path: string,
  kind: string,
  label: string,
  summary: string,
  item: T,
  select: (target: UniversalProfile) => T[],
  matches: (candidate: T) => boolean,
): FlatEntry {
  return {
    path,
    kind,
    label,
    summary: truncate(summary),
    canonical: canonicalStringify(item),
    apply: (target) => {
      const list = select(target);
      const index = list.findIndex(matches);
      const copy = structuredClone(item);
      if (index === -1) list.push(copy);
      else list[index] = copy;
    },
    remove: (target) => {
      const list = select(target);
      const index = list.findIndex(matches);
      if (index !== -1) list.splice(index, 1);
    },
  };
}

/** Decompose a profile into independently mergeable entries keyed by stable path. */
export function flattenProfile(profile: UniversalProfile): Map<string, FlatEntry> {
  const entries = new Map<string, FlatEntry>();
  const add = (entry: FlatEntry) => entries.set(entry.path, entry);

  for (const field of ['displayName', 'email', 'pronouns', 'bio'] as const) {
    const value = profile.identity[field];
    if (!value) continue;
    add(
      scalarEntry(ProfilePaths.identity(field), 'identity', field, value, (target, next) => {
        if (next === undefined) delete target.identity[field];
        else target.identity[field] = next;
      }),
    );
  }

  for (const field of ['language', 'communicationStyle', 'timezone'] as const) {
    const value = profile.preferences[field];
    if (!value) continue;
    add(
      scalarEntry(
        ProfilePaths.preference(field),
        'preference',
        `${field} = ${value}`,
        value,
        (target, next) => {
          if (next === undefined) delete target.preferences[field];
          else (target.preferences as Record<string, unknown>)[field] = next;
        },
      ),
    );
  }

  for (const [key, value] of Object.entries(profile.preferences.custom)) {
    add(
      scalarEntry(
        ProfilePaths.customPreference(key),
        'preference',
        `${key} = ${value}`,
        value,
        (target, next) => {
          if (next === undefined) delete target.preferences.custom[key];
          else target.preferences.custom[key] = next;
        },
      ),
    );
  }

  for (const role of ['coding', 'general', 'reasoning', 'fast'] as const) {
    const value = profile.models[role];
    if (!value) continue;
    add(
      scalarEntry(
        ProfilePaths.model(role),
        'model',
        `${role} = ${value}`,
        value,
        (target, next) => {
          if (next === undefined) delete target.models[role];
          else target.models[role] = next;
        },
      ),
    );
  }

  for (const field of ['codingStyle', 'packageManager', 'testCommand'] as const) {
    const value = profile.workspace[field];
    if (!value) continue;
    add(
      scalarEntry(
        ProfilePaths.workspace(field),
        'workspace',
        `${field} = ${value}`,
        value,
        (target, next) => {
          if (next === undefined) delete target.workspace[field];
          else (target.workspace as Record<string, unknown>)[field] = next;
        },
      ),
    );
  }

  for (const server of profile.mcp) {
    add(
      collectionEntry<McpServer>(
        ProfilePaths.mcp(server.name),
        'MCP',
        server.name,
        server.command ?? server.url ?? server.transport,
        server,
        (target) => target.mcp,
        (candidate) => candidate.name === server.name,
      ),
    );
  }

  for (const skill of profile.skills) {
    add(
      collectionEntry<Skill>(
        ProfilePaths.skill(skill.name),
        'skill',
        skill.name,
        skill.description || skill.name,
        skill,
        (target) => target.skills,
        (candidate) => candidate.name === skill.name,
      ),
    );
  }

  for (const rule of profile.workspace.rules) {
    add(
      collectionEntry<WorkspaceRule>(
        ProfilePaths.rule(rule.id),
        'rule',
        rule.title || rule.id,
        rule.content,
        rule,
        (target) => target.workspace.rules,
        (candidate) => candidate.id === rule.id,
      ),
    );
  }

  for (const project of profile.workspace.projects) {
    add(
      collectionEntry<Project>(
        ProfilePaths.project(project.name),
        'project',
        project.name,
        project.description ?? project.path ?? project.name,
        project,
        (target) => target.workspace.projects,
        (candidate) => candidate.name === project.name,
      ),
    );
  }

  for (const [name, reference] of Object.entries(profile.secrets.references)) {
    add(
      scalarEntry(
        ProfilePaths.secretRef(name),
        'secret reference',
        `${name} -> ${reference}`,
        reference,
        (target, next) => {
          if (next === undefined) delete target.secrets.references[name];
          else target.secrets.references[name] = next;
        },
      ),
    );
  }

  for (const artifact of profile.artifacts) {
    add(
      collectionEntry<Artifact>(
        ProfilePaths.artifact(artifact.agent, artifact.path),
        'original file',
        `${artifact.agent}: ${artifact.path}`,
        `${artifact.bytes} bytes`,
        artifact,
        (target) => target.artifacts,
        (candidate) => candidate.agent === artifact.agent && candidate.path === artifact.path,
      ),
    );
  }

  return entries;
}
