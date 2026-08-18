import type { UniversalProfile } from './schema.js';

/**
 * Stable, addressable identifiers for every mutable piece of a profile.
 *
 * Diff, merge, and conflict resolution all operate on these strings rather than on
 * object identity, so a path is part of the wire format: renaming one is a schema
 * migration, not a refactor.
 */
export const ProfilePaths = {
  identity: (field: keyof UniversalProfile['identity']) => `identity.${field}`,
  preference: (field: string) => `preferences.${field}`,
  customPreference: (key: string) => `preferences.custom.${key}`,
  model: (role: string) => `models.${role}`,
  mcp: (name: string) => `mcp.${name}`,
  skill: (name: string) => `skills.${name}`,
  rule: (id: string) => `workspace.rules.${id}`,
  project: (name: string) => `workspace.projects.${name}`,
  workspace: (field: string) => `workspace.${field}`,
  secretRef: (name: string) => `secrets.references.${name}`,
  memory: (field: string) => `memory.${field}`,
} as const;

/** Human-facing section label used by `agentpass diff`. */
export function sectionOf(path: string): string {
  const head = path.split('.')[0] ?? '';
  switch (head) {
    case 'identity':
      return 'Identity';
    case 'preferences':
      return 'Preferences';
    case 'models':
      return 'Model preferences';
    case 'mcp':
      return 'MCP servers';
    case 'skills':
      return 'Skills';
    case 'workspace':
      return 'Workspace rules';
    case 'secrets':
      return 'Secret references';
    case 'memory':
      return 'Memory';
    default:
      return head || 'Profile';
  }
}
