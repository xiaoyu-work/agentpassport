import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const useColor = stdout.isTTY && !process.env['NO_COLOR'];

const wrap = (code: string) => (text: string) =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

export const bold = wrap('1');
export const dim = wrap('2');
export const green = wrap('32');
export const yellow = wrap('33');
export const red = wrap('31');
export const cyan = wrap('36');

export function heading(text: string): void {
  stdout.write(`\n${bold(text)}\n`);
}

export function line(text = ''): void {
  stdout.write(`${text}\n`);
}

export function ok(text: string): void {
  line(`${green('✓')} ${text}`);
}

export function warn(text: string): void {
  line(`${yellow('!')} ${text}`);
}

export function fail(text: string): void {
  line(`${red('✗')} ${text}`);
}

export function bullet(text: string): void {
  line(`  ${text}`);
}

export async function ask(question: string, fallback = ''): Promise<string> {
  if (!stdin.isTTY) return fallback;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (process.env['AGENTPASS_YES'] === '1') return true;
  if (!stdin.isTTY) return defaultYes;
  const answer = await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `);
  if (!answer) return defaultYes;
  return /^y(es)?$/i.test(answer);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
