import {
  CommunicationStyleSchema,
  type Project,
  type UniversalProfile,
  type WorkspaceRule,
} from '@agentpass/profile';
import { isRestorable, type MemoryRecord } from '@agentpass/memory';

/**
 * The agent-neutral body written into CLAUDE.md, AGENTS.md, and Cursor rules.
 *
 * `render` and `parse` are inverses. Round-tripping matters because a user will import
 * from the agent we last exported to, and a lossy pass would quietly erase identity every
 * time they alternate between two tools.
 */
export function renderInstructions(
  profile: UniversalProfile,
  memories: MemoryRecord[] = [],
): string {
  const lines: string[] = [];
  const name = profile.identity.displayName;
  lines.push(name ? `# Agent Passport — ${name}` : '# Agent Passport');
  lines.push('');
  lines.push('Managed by Agent Passport. Edit above or below this block, not inside it.');

  const about = [
    entryLine('Display name', profile.identity.displayName),
    entryLine('Email', profile.identity.email),
    entryLine('Pronouns', profile.identity.pronouns),
    entryLine('Timezone', profile.preferences.timezone),
    entryLine('Language', profile.preferences.language),
    entryLine('Communication style', profile.preferences.communicationStyle),
    entryLine('Bio', profile.identity.bio),
  ].filter((line): line is string => line !== undefined);
  if (about.length > 0) {
    lines.push('', '## About me', '', ...about);
  }

  const workspace = [
    entryLine('Package manager', profile.workspace.packageManager),
    entryLine('Coding style', profile.workspace.codingStyle),
    entryLine('Test command', profile.workspace.testCommand),
    ...Object.entries(profile.workspace.custom).map(([key, value]) => `- ${key}: ${value}`),
  ].filter((line): line is string => line !== undefined);
  if (workspace.length > 0) {
    lines.push('', '## Workspace', '', ...workspace);
  }

  if (profile.workspace.projects.length > 0) {
    lines.push('', '## Projects', '');
    for (const project of profile.workspace.projects) {
      const detail = project.description ?? project.path ?? '';
      lines.push(detail ? `- ${project.name}: ${detail}` : `- ${project.name}`);
    }
  }

  const rules = profile.workspace.rules.filter((rule) => rule.content.trim());
  if (rules.length > 0) {
    lines.push('', '## Rules');
    for (const rule of rules) {
      // The id travels with the rule. Re-deriving it from the title on the way back in
      // would mint a new id for the same rule, so every import-export cycle would append
      // a duplicate instead of updating in place.
      lines.push(
        '',
        `### ${rule.title || rule.id}`,
        `${RULE_ID_PREFIX}${rule.id} -->`,
        '',
        rule.content.trim(),
      );
    }
  }

  const restorable = memories.filter(isRestorable);
  if (restorable.length > 0) {
    lines.push('', '## Memory', '');
    for (const memory of restorable) {
      lines.push(`- ${memory.content.replace(/\s+/g, ' ').trim()}`);
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

export interface ParsedInstructions {
  displayName?: string;
  email?: string;
  pronouns?: string;
  bio?: string;
  timezone?: string;
  language?: string;
  communicationStyle?: string;
  packageManager?: string;
  codingStyle?: string;
  testCommand?: string;
  custom: Record<string, string>;
  projects: Project[];
  rules: Array<Pick<WorkspaceRule, 'id' | 'title' | 'content'>>;
}

const KNOWN_WORKSPACE_KEYS = new Set(['package manager', 'coding style', 'test command']);

export const RULE_ID_PREFIX = '<!-- agentpass:rule-id=';
const RULE_ID_PATTERN = /^<!--\s*agentpass:rule-id=(.+?)\s*-->$/;

export function parseInstructions(markdown: string): ParsedInstructions {
  const result: ParsedInstructions = { custom: {}, projects: [], rules: [] };
  if (!markdown.trim()) return result;

  let section = '';
  let ruleTitle = '';
  let ruleId = '';
  let ruleBody: string[] = [];

  const flushRule = () => {
    if (!ruleTitle) return;
    const content = ruleBody.join('\n').trim();
    if (content) result.rules.push({ id: ruleId || slug(ruleTitle), title: ruleTitle, content });
    ruleTitle = '';
    ruleId = '';
    ruleBody = [];
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();

    const heading2 = line.match(/^##\s+(.*)$/);
    if (heading2) {
      flushRule();
      section = (heading2[1] ?? '').trim().toLowerCase();
      continue;
    }

    const heading3 = line.match(/^###\s+(.*)$/);
    if (heading3 && section === 'rules') {
      flushRule();
      ruleTitle = (heading3[1] ?? '').trim();
      continue;
    }

    if (section === 'rules') {
      if (!ruleTitle) continue;
      const marker = line.trim().match(RULE_ID_PATTERN);
      if (marker && !ruleBody.length) {
        ruleId = (marker[1] ?? '').trim();
        continue;
      }
      ruleBody.push(line);
      continue;
    }

    // Memories are owned by the memory provider, not by the instruction file. Re-reading
    // them here would fork the record and let a stale copy outlive a deletion.
    if (section === 'memory') continue;

    const bullet = line.match(/^-\s+(.+?):\s*(.*)$/);
    if (!bullet) continue;
    const key = (bullet[1] ?? '').trim();
    const value = (bullet[2] ?? '').trim();
    if (!value) continue;

    if (section === 'projects') {
      result.projects.push({ name: key, description: value });
      continue;
    }
    assign(result, key.toLowerCase(), value, section);
  }

  flushRule();
  return result;
}

function assign(result: ParsedInstructions, key: string, value: string, section: string): void {
  switch (key) {
    case 'display name':
      result.displayName = value;
      return;
    case 'email':
      result.email = value;
      return;
    case 'pronouns':
      result.pronouns = value;
      return;
    case 'bio':
      result.bio = value;
      return;
    case 'timezone':
      result.timezone = value;
      return;
    case 'language':
      result.language = value;
      return;
    case 'communication style':
      if (CommunicationStyleSchema.safeParse(value).success) result.communicationStyle = value;
      return;
    case 'package manager':
      result.packageManager = value;
      return;
    case 'coding style':
      result.codingStyle = value;
      return;
    case 'test command':
      result.testCommand = value;
      return;
    default:
      if (section === 'workspace' && !KNOWN_WORKSPACE_KEYS.has(key)) result.custom[key] = value;
  }
}

function entryLine(label: string, value: string | undefined): string | undefined {
  return value ? `- ${label}: ${value}` : undefined;
}

export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'rule'
  );
}

const PACKAGE_MANAGER_HINT =
  /\b(?:prefers?|use|using|always\s+use|standard(?:ise|ize)d?\s+on)\s+(pnpm|npm|yarn|bun)\b/i;

/**
 * Recover a few structured settings from prose instructions.
 *
 * Deliberately narrow. A false positive here becomes a preference the user never stated
 * and cannot easily find, so only unambiguous phrasings are matched.
 */
export function inferWorkspaceHints(text: string): { packageManager?: string } {
  const match = text.match(PACKAGE_MANAGER_HINT);
  const manager = match?.[1]?.toLowerCase();
  return manager ? { packageManager: manager } : {};
}
