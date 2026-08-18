import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Skill } from '@agentpass/profile';
import { readTextIfExists } from './fsx.js';
import { parseFrontmatter, renderFrontmatter } from './markdown.js';

export const SKILL_FILENAME = 'SKILL.md';

/**
 * Read a `skills/<name>/SKILL.md` tree.
 *
 * Claude Code, OpenClaw, and Codex all landed on the same layout, so one reader serves
 * all three and a skill written for any of them travels to the others unchanged.
 */
export async function readSkillsDir(directory: string): Promise<Skill[]> {
  let names: string[];
  try {
    const dirents = await readdir(directory, { withFileTypes: true });
    names = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const skills: Skill[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const text = await readTextIfExists(join(directory, name, SKILL_FILENAME));
    if (text === undefined) continue;
    const { data, body } = parseFrontmatter(text);
    skills.push({
      name: typeof data['name'] === 'string' ? data['name'] : name,
      description: typeof data['description'] === 'string' ? data['description'] : '',
      source: 'local',
      enabled: data['enabled'] !== false,
      content: body,
    });
  }
  return skills;
}

export function renderSkillFile(skill: Skill): string {
  return renderFrontmatter(
    { name: skill.name, description: skill.description || undefined },
    skill.content ?? '',
  );
}

export function skillFilePath(directory: string, skill: Skill): string {
  return join(directory, skill.name, SKILL_FILENAME);
}
