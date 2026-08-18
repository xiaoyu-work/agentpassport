import type { MemoryDraft, MemoryRecord } from '@agentpass/memory';
import type { UniversalProfile } from '@agentpass/profile';

/**
 * Everything an adapter is allowed to know about the machine it runs on.
 *
 * Adapters never read `process.env` or `os.homedir()` directly. Routing those through a
 * context is what makes every adapter testable against a temporary directory instead of
 * the developer's real, irreplaceable agent configuration.
 */
export interface AdapterContext {
  /** Home directory to resolve `~`-rooted agent config against. */
  home: string;
  /** Project directory, for project-scoped config such as `.mcp.json` or `.cursor/rules`. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Stable identifier for this machine, recorded as `sourceDevice` in field metadata. */
  device: string;
  /** When true, `export` must compute changes and write nothing. */
  dryRun: boolean;
}

export type WarningSeverity = 'info' | 'warn' | 'security';

export interface AdapterWarning {
  severity: WarningSeverity;
  message: string;
  /** File that produced the warning, when there is one. */
  file?: string;
}

export interface ImportResult {
  profile: UniversalProfile;
  /** Candidate long-term memories. Policy decides whether they ever become active. */
  memories: MemoryDraft[];
  warnings: AdapterWarning[];
  /** Absolute paths that were read, shown by the CLI so users can audit an import. */
  sources: string[];
}

export type ChangeOperation = 'create' | 'update' | 'delete' | 'unchanged';

export interface ConfigChange {
  op: ChangeOperation;
  file: string;
  description: string;
  before?: string;
  after?: string;
}

export interface AgentConfigDiff {
  agent: string;
  changes: ConfigChange[];
  warnings: AdapterWarning[];
}

export interface ExportResult {
  agent: string;
  written: string[];
  skipped: string[];
  warnings: AdapterWarning[];
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  file?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * The contract every supported agent implements.
 *
 * Adapters must be bidirectional and idempotent: `export` twice must produce the same
 * files, and `import` after `export` must round-trip the fields the agent can represent.
 * That symmetry is the product — a one-way copier would strand users on whichever agent
 * they configured first.
 */
export interface AgentAdapter {
  /** Stable machine name used on the command line, e.g. `claude`. */
  readonly id: string;
  /** Human-facing name, e.g. `Claude Code`. */
  readonly displayName: string;

  /** Whether this agent appears to be installed and configured on this machine. */
  detect(context: AdapterContext): Promise<boolean>;

  /** Read native configuration and translate it into the universal representation. */
  import(context: AdapterContext, userId: string): Promise<ImportResult>;

  /** Compute the exact file changes `export` would make, without touching disk. */
  previewExport(
    context: AdapterContext,
    profile: UniversalProfile,
    memories?: MemoryRecord[],
  ): Promise<AgentConfigDiff>;

  /** Translate the universal representation into native configuration and write it. */
  export(
    context: AdapterContext,
    profile: UniversalProfile,
    memories?: MemoryRecord[],
  ): Promise<ExportResult>;

  /** Check that this agent's on-disk configuration is well-formed. */
  validate(context: AdapterContext): Promise<ValidationResult>;
}
