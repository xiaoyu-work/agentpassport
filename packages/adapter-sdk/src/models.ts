/**
 * Canonical model references are `vendor/model`, e.g. `anthropic/claude-sonnet-4-6`.
 *
 * Agents disagree about spelling: Claude Code writes a bare `sonnet`, Codex writes a bare
 * `gpt-5.5`, OpenClaw writes a qualified `anthropic/claude-sonnet-4-6`. Normalizing on the
 * way in is what lets a model preference survive a move between them.
 */
const BARE_ALIASES: Record<string, string> = {
  sonnet: 'anthropic/claude-sonnet',
  opus: 'anthropic/claude-opus',
  haiku: 'anthropic/claude-haiku',
};

export function toCanonicalModel(value: string, defaultVendor: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const alias = BARE_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    const vendor = trimmed.slice(0, slash).toLowerCase();
    const model = trimmed.slice(slash + 1);
    return `${vendor}/${model}`;
  }
  return `${defaultVendor.toLowerCase()}/${trimmed}`;
}

export function modelVendor(canonical: string): string {
  const slash = canonical.indexOf('/');
  return slash > 0 ? canonical.slice(0, slash).toLowerCase() : '';
}

export function modelName(canonical: string): string {
  const slash = canonical.indexOf('/');
  return slash > 0 ? canonical.slice(slash + 1) : canonical;
}

/**
 * Render a canonical reference in an agent's native spelling.
 *
 * Returns undefined when the agent cannot express the model at all — an agent that only
 * speaks to Anthropic has no way to name an OpenAI model, and writing a nonsense value
 * would break it on next launch.
 */
export function toNativeModel(
  canonical: string | undefined,
  options: { qualified: boolean; vendor?: string },
): string | undefined {
  if (!canonical) return undefined;
  if (options.qualified) return canonical;
  if (options.vendor && modelVendor(canonical) !== options.vendor.toLowerCase()) return undefined;
  return modelName(canonical);
}
