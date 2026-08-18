import { looksLikeSecret } from './policy.js';
import type { MemoryCategory, MemoryDraft, MemoryScope, Provenance } from './schema.js';

/**
 * Wording that only means something inside one specific agent.
 *
 * Extraction defaults to shared, because a fact about the user is true everywhere. The
 * narrow exception is instruction text about an agent's own machinery — a note about
 * Claude Code's Task tool is noise in Cursor, and worse, it is *confusing* noise that
 * makes a restored agent look broken. These stay pinned to the agent they came from, and
 * the user can widen any of them later.
 */
const AGENT_SPECIFIC_HINT =
  /\b(claude code|claude\.md|openclaw|codex cli|cursor rules?|\.cursor\/|agents\.md|slash command|\/compact\b|\/clear\b|subagent|task tool|output style|mcp server config|settings\.json|config\.toml)\b/i;

export interface ExtractOptions {
  source: string;
  sourceAgent: string;
  scope?: MemoryScope;
  provenance?: Provenance;
  /** Project identifier recorded on project-scoped memories. */
  project?: string;
}

const CATEGORY_RULES: Array<{ category: MemoryCategory; pattern: RegExp; weight: number }> = [
  {
    category: 'identity',
    pattern: /\b(my name is|i am|i'm|call me|i work at|my timezone|i live in)\b/i,
    weight: 0.2,
  },
  {
    category: 'preference',
    pattern:
      /\b(prefer|prefers|preferred|favou?rite|rather than|instead of|always use|never use|don't use|do not use)\b/i,
    weight: 0.2,
  },
  {
    category: 'workflow',
    pattern:
      /\b(always run|before committing|after editing|workflow|make sure to|be sure to|when you finish|每次|务必)\b/i,
    weight: 0.15,
  },
  {
    category: 'decision',
    pattern: /\b(we decided|decision|standard is|convention is|we use|the rule is)\b/i,
    weight: 0.15,
  },
  {
    category: 'tool',
    pattern:
      /\b(pnpm|npm|yarn|bun|docker|kubectl|git|eslint|prettier|vitest|jest|pytest|cargo|poetry)\b/i,
    weight: 0.1,
  },
  {
    category: 'project',
    pattern: /\b(project|repo|repository|codebase|service|monorepo|package)\b/i,
    weight: 0.1,
  },
  {
    category: 'relationship',
    pattern: /\b(my team|my manager|colleague|teammate|we are a team)\b/i,
    weight: 0.1,
  },
];

const MIN_LENGTH = 12;
const MAX_LENGTH = 320;

/**
 * Derive candidate long-term memories from an agent's markdown instruction file.
 *
 * This is intentionally lossy. The full file is preserved verbatim as a workspace rule;
 * what comes out of here are discrete, portable statements that are worth carrying to a
 * *different* agent. Everything produced starts life as `imported`, which policy holds
 * for review rather than trusting outright.
 */
export function extractMemories(markdown: string, options: ExtractOptions): MemoryDraft[] {
  const provenance = options.provenance ?? 'imported';
  const scope = options.scope ?? 'global';
  const drafts: MemoryDraft[] = [];
  const seen = new Set<string>();

  for (const line of candidateLines(markdown)) {
    const content = line.trim();
    if (content.length < MIN_LENGTH || content.length > MAX_LENGTH) continue;

    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let category: MemoryCategory = 'fact';
    let confidence = 0.55;
    let matched = false;
    for (const rule of CATEGORY_RULES) {
      if (rule.pattern.test(content)) {
        if (!matched) category = rule.category;
        confidence += rule.weight;
        matched = true;
      }
    }
    if (!matched) continue;

    const secret = looksLikeSecret(content);
    // Shared unless the text is about one agent's own machinery.
    const agentSpecific = AGENT_SPECIFIC_HINT.test(content);
    drafts.push({
      content,
      category,
      provenance,
      source: options.source,
      sourceAgent: options.sourceAgent,
      confidence: Math.min(0.95, Number(confidence.toFixed(2))),
      scope,
      ...(options.project ? { project: options.project } : {}),
      sharing: agentSpecific ? 'agent_specific' : 'shared',
      agents: agentSpecific ? [options.sourceAgent] : [],
      sensitivity: secret ? 'secret' : 'private',
      syncEnabled: !secret,
    });
  }

  return drafts;
}

/** Yield prose lines, skipping fenced code, headings, tables, and link-only lines. */
function candidateLines(markdown: string): string[] {
  const lines: string[] = [];
  let inFence = false;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    if (line.startsWith('#') || line.startsWith('|') || line.startsWith('>')) continue;
    if (/^[-*_]{3,}$/.test(line)) continue;

    const stripped = stripInlineMarkup(
      line
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(/^\[[ xX]\]\s+/, ''),
    ).trim();

    if (!stripped || /^https?:\/\/\S+$/.test(stripped)) continue;
    lines.push(stripped);
  }

  return lines;
}

/**
 * Remove emphasis and code markers without damaging the text they surround.
 *
 * Stripping `*`, `_`, and backticks indiscriminately corrupts the very content worth
 * remembering: `America/Los_Angeles` becomes `America/LosAngeles`, and `GITHUB_TOKEN`
 * becomes `GITHUBTOKEN`. A memory is meant to be handed back to an agent verbatim, so a
 * silently mangled one is worse than no memory at all. Only paired delimiters at word
 * boundaries are treated as markup.
 */
function stripInlineMarkup(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
    .replace(/(?<![A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/g, '$1')
    .replace(/(?<![A-Za-z0-9*])\*(?=\S)([^*]*?\S)\*(?![A-Za-z0-9*])/g, '$1')
    .replace(/(?<![A-Za-z0-9_])_(?=\S)([^_]*?\S)_(?![A-Za-z0-9_])/g, '$1');
}
