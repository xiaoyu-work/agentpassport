import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Build a throwaway HOME so tests never touch the developer's real agent configuration. */
export async function makeSandbox(name: string): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), `agentpass-${name}-`));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const passportHome = join(root, 'passport');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return { root, home, project, passportHome, env: baseEnv(home, passportHome) };
}

export interface Sandbox {
  root: string;
  home: string;
  project: string;
  passportHome: string;
  env: NodeJS.ProcessEnv;
}

function baseEnv(home: string, passportHome: string): NodeJS.ProcessEnv {
  return {
    AGENTPASS_HOME: passportHome,
    AGENTPASS_AGENT_HOME: home,
    AGENTPASS_DEVICE: 'test-device',
    PATH: process.env['PATH'] ?? '',
  };
}

export async function write(path: string, contents: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

export async function read(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** A realistic Claude Code setup: prose instructions, settings, and MCP servers. */
export async function seedClaude(sandbox: Sandbox): Promise<void> {
  await write(
    join(sandbox.home, '.claude', 'CLAUDE.md'),
    [
      '# My instructions',
      '',
      'I prefer pnpm over npm for all JavaScript projects.',
      'Always run the tests before committing changes.',
      'I am a staff engineer working mostly on TypeScript services.',
      '',
      '## Style',
      '',
      'Keep responses concise and skip the preamble.',
    ].join('\n'),
  );

  await write(
    join(sandbox.home, '.claude', 'settings.json'),
    JSON.stringify({ model: 'sonnet', outputStyle: 'concise' }, null, 2),
  );

  await write(
    join(sandbox.home, '.claude.json'),
    JSON.stringify(
      {
        mcpServers: {
          github: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_exampletokenvalue1234567890abcd' },
          },
          filesystem: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
        someUnrelatedKey: { keepMe: true },
      },
      null,
      2,
    ),
  );
}
