/**
 * Known agents, as data only.
 *
 * This exists to solve a chicken-and-egg problem: detecting an agent properly requires its
 * adapter, but we want to tell someone "you have Cursor installed, here is the plugin for
 * it" *before* they have that plugin. So core keeps a table of the well-known paths and
 * nothing else — no parsing, no writing, no logic. Everything that actually reads or
 * writes an agent's files lives in the plugin.
 *
 * A third-party plugin does not need an entry here. Entries only improve the suggestion
 * shown to a user who has not installed a plugin yet.
 */
export type HintKind = 'instructions' | 'settings' | 'mcp' | 'memory' | 'skills';

export interface PathHint {
  /**
   * `~/` resolves against the agent home, `./` against the project directory.
   * Environment overrides such as `CODEX_HOME` are honoured by the plugin itself.
   */
  path: string;
  kind: HintKind;
}

export interface CatalogEntry {
  id: string;
  displayName: string;
  /** npm package providing the adapter plugin. */
  package: string;
  hints: PathHint[];
}

export const AGENT_CATALOG: CatalogEntry[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    package: '@agentpassport/adapter-claude',
    hints: [
      { path: '~/.claude/CLAUDE.md', kind: 'instructions' },
      { path: '~/.claude/settings.json', kind: 'settings' },
      { path: '~/.claude.json', kind: 'mcp' },
      { path: '~/.claude/skills', kind: 'skills' },
      { path: './CLAUDE.md', kind: 'instructions' },
      { path: './.mcp.json', kind: 'mcp' },
    ],
  },
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    package: '@agentpassport/adapter-openclaw',
    hints: [
      { path: '~/.openclaw/openclaw.json', kind: 'settings' },
      { path: '~/.openclaw/workspace/AGENTS.md', kind: 'instructions' },
      { path: '~/.openclaw/workspace/USER.md', kind: 'instructions' },
      { path: '~/.openclaw/workspace/MEMORY.md', kind: 'memory' },
      { path: '~/.openclaw/skills', kind: 'skills' },
    ],
  },
  {
    id: 'codex',
    displayName: 'OpenAI Codex',
    package: '@agentpassport/adapter-codex',
    hints: [
      { path: '~/.codex/config.toml', kind: 'settings' },
      { path: '~/.codex/AGENTS.md', kind: 'instructions' },
      { path: '~/.codex/skills', kind: 'skills' },
      { path: './AGENTS.md', kind: 'instructions' },
    ],
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    package: '@agentpassport/adapter-cursor',
    hints: [
      { path: '~/.cursor/mcp.json', kind: 'mcp' },
      { path: './.cursor/rules', kind: 'instructions' },
      { path: './.cursor/mcp.json', kind: 'mcp' },
      { path: './AGENTS.md', kind: 'instructions' },
    ],
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return AGENT_CATALOG.find((entry) => entry.id === id);
}

/** Packages the loader tries by default. Missing ones are simply skipped. */
export function bundledPackages(): string[] {
  return AGENT_CATALOG.map((entry) => entry.package);
}
