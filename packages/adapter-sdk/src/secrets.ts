import { SECRET_REFERENCE_PATTERN } from '@agentpassport/profile';
import type { AdapterWarning } from './types.js';

/** Variable names that conventionally hold credential material. */
const SECRET_NAME_PATTERN =
  /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|PAT|ACCESS_KEY|PRIVATE_KEY|SESSION)($|_)/i;

/** Value shapes that are credential material regardless of the variable name. */
const SECRET_VALUE_PATTERN =
  /^(sk-[\w-]{16,}|ghp_[\w]{20,}|github_pat_[\w]{20,}|xox[baprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/;

/** Shell or template indirection, which contains no secret itself. */
const INDIRECTION_PATTERN = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

export interface RedactedEnv {
  /** Values safe to store in the profile and sync to the cloud. */
  env: Record<string, string>;
  /** Variable name -> secret reference URI, resolved at agent launch time. */
  secretRefs: Record<string, string>;
  warnings: AdapterWarning[];
}

/**
 * Split an environment map into inert configuration and secret references.
 *
 * MCP server definitions routinely inline a live API key in `env`. Copying those into a
 * synced profile would turn Agent Passport into the single richest credential target on
 * the user's machine, so the value is dropped at the boundary and replaced by a pointer.
 * The user keeps the key exactly where it already was.
 */
export function redactEnv(
  env: Record<string, string> | undefined,
  options: { file?: string; server?: string } = {},
): RedactedEnv {
  const result: RedactedEnv = { env: {}, secretRefs: {}, warnings: [] };
  if (!env) return result;

  for (const [name, rawValue] of Object.entries(env)) {
    const value = String(rawValue ?? '');

    if (SECRET_REFERENCE_PATTERN.test(value)) {
      result.secretRefs[name] = value;
      continue;
    }
    if (!value || INDIRECTION_PATTERN.test(value)) {
      result.env[name] = value;
      continue;
    }

    const isSecret = SECRET_NAME_PATTERN.test(name) || SECRET_VALUE_PATTERN.test(value);
    if (!isSecret) {
      result.env[name] = value;
      continue;
    }

    result.secretRefs[name] = `env://${name}`;
    const where = options.server ? `${options.server}.env.${name}` : name;
    result.warnings.push({
      severity: 'security',
      message: `${where} looked like a credential; stored a reference (env://${name}) instead of the value`,
      ...(options.file ? { file: options.file } : {}),
    });
  }

  return result;
}

/**
 * Rebuild a native `env` map for export.
 *
 * References are re-emitted as `${VAR}` indirection rather than resolved values: the
 * exported config is a file on disk that may be committed, backed up, or synced, and it
 * must not become a new place a secret lives.
 */
export function expandEnv(
  env: Record<string, string>,
  secretRefs: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...env };
  for (const [name, reference] of Object.entries(secretRefs)) {
    merged[name] = reference.startsWith('env://')
      ? `\${${reference.slice('env://'.length)}}`
      : `\${${name}}`;
  }
  return merged;
}
