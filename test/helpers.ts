import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Sandbox {
  root: string;
  home: string;
  project: string;
  passportHome: string;
  env: NodeJS.ProcessEnv;
}

/** Throwaway HOME so tests never touch the developer's real config. */
export async function makeSandbox(name: string): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), `agentpass-${name}-`));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const passportHome = join(root, 'passport');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return { root, home, project, passportHome, env: baseEnv(home, passportHome) };
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
