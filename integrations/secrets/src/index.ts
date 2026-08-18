import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Resolves a secret *reference* to material, at the moment of use.
 *
 * Agent Passport never stores, syncs, or logs the material itself, and nothing here is
 * ever placed into a profile, a config file, or an LLM context. The reference is the only
 * thing that travels; resolution happens on the user's machine, against a vault they
 * already trust.
 */
export interface SecretResolver {
  readonly scheme: string;
  /** Whether the backing tool is available, checked before promising the user anything. */
  available(): Promise<boolean>;
  resolve(reference: string): Promise<string>;
}

export class SecretResolutionError extends Error {
  constructor(
    message: string,
    readonly reference: string,
  ) {
    super(message);
    this.name = 'SecretResolutionError';
  }
}

/** `env://OPENAI_API_KEY` — the material stays in the user's shell, exactly as before. */
export class EnvResolver implements SecretResolver {
  readonly scheme = 'env';

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async available(): Promise<boolean> {
    return true;
  }

  async resolve(reference: string): Promise<string> {
    const name = reference.slice('env://'.length);
    const value = this.env[name];
    if (!value) {
      throw new SecretResolutionError(`environment variable ${name} is not set`, reference);
    }
    return value;
  }
}

/** `op://Vault/item/field`, resolved by the 1Password CLI. */
export class OnePasswordResolver implements SecretResolver {
  readonly scheme = 'op';

  async available(): Promise<boolean> {
    try {
      await run('op', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async resolve(reference: string): Promise<string> {
    try {
      const { stdout } = await run('op', ['read', reference], { timeout: 20000 });
      return stdout.trim();
    } catch (error) {
      throw new SecretResolutionError(
        `1Password could not read ${reference}: ${(error as Error).message}`,
        reference,
      );
    }
  }
}

/** `infisical://<project>/<environment>/<KEY>`, resolved by the Infisical CLI. */
export class InfisicalResolver implements SecretResolver {
  readonly scheme = 'infisical';

  async available(): Promise<boolean> {
    try {
      await run('infisical', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async resolve(reference: string): Promise<string> {
    const [project, environment, key] = reference.slice('infisical://'.length).split('/');
    if (!project || !environment || !key) {
      throw new SecretResolutionError(
        'expected infisical://<project>/<environment>/<KEY>',
        reference,
      );
    }
    try {
      const { stdout } = await run(
        'infisical',
        ['secrets', 'get', key, '--projectId', project, '--env', environment, '--plain'],
        { timeout: 20000 },
      );
      return stdout.trim();
    } catch (error) {
      throw new SecretResolutionError(
        `Infisical could not read ${key}: ${(error as Error).message}`,
        reference,
      );
    }
  }
}

export class SecretRegistry {
  private readonly resolvers = new Map<string, SecretResolver>();

  constructor(resolvers: SecretResolver[] = []) {
    for (const resolver of resolvers) this.resolvers.set(resolver.scheme, resolver);
  }

  static default(env: NodeJS.ProcessEnv = process.env): SecretRegistry {
    return new SecretRegistry([
      new EnvResolver(env),
      new OnePasswordResolver(),
      new InfisicalResolver(),
    ]);
  }

  async resolve(reference: string): Promise<string> {
    const scheme = reference.split('://')[0];
    const resolver = scheme ? this.resolvers.get(scheme) : undefined;
    if (!resolver) {
      throw new SecretResolutionError(`no resolver for scheme "${scheme}"`, reference);
    }
    if (!(await resolver.available())) {
      throw new SecretResolutionError(`the ${scheme} provider is not installed`, reference);
    }
    return resolver.resolve(reference);
  }

  /**
   * Report which references can currently be resolved.
   *
   * Deliberately returns availability only, never a value: `agentpass status` must be able
   * to tell a user their credentials are reachable without putting one on screen.
   */
  async check(references: Record<string, string>): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    for (const [name, reference] of Object.entries(references)) {
      const scheme = reference.split('://')[0];
      const resolver = scheme ? this.resolvers.get(scheme) : undefined;
      result[name] = resolver ? await resolver.available() : false;
    }
    return result;
  }
}
