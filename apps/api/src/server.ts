import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EncryptedEnvelope, Keyring } from '@agentpass/crypto';

/**
 * Reference sync server.
 *
 * It stores opaque ciphertext and nothing else. There is no decryption path here, by
 * design: the production service should be able to lose its entire database without
 * leaking a single user preference. Everything the server can see — a user id, a revision
 * number, a timestamp — is metadata it needs to order writes and refuse stale ones.
 *
 * Real deployments should swap the filesystem for Postgres and the bearer token for a
 * managed identity provider. Neither changes the contract.
 */

const HOST = process.env['AGENTPASS_API_HOST'] ?? '127.0.0.1';
const PORT = Number(process.env['AGENTPASS_API_PORT'] ?? 4100);
const DATA_DIR = process.env['AGENTPASS_API_DATA'] ?? join(process.cwd(), '.agentpass-server');
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REVISIONS = 50;

interface StoredProfile {
  envelope: EncryptedEnvelope;
  /**
   * The data key wrapped under the user's passphrase.
   *
   * Storing it is what lets a new device join an account. It is opaque here: unwrapping
   * requires the passphrase, which is never sent, so holding this grants the server no
   * more access than holding the envelope alone.
   */
  keyring: Keyring;
  revision: number;
  updatedAt: string;
}

function profilePath(userId: string): string {
  // Hex-encode so a user id can never escape the data directory or collide on a
  // case-insensitive filesystem.
  return join(DATA_DIR, `${Buffer.from(userId, 'utf8').toString('hex')}.json`);
}

function revisionPath(userId: string, revision: number): string {
  const encoded = Buffer.from(userId, 'utf8').toString('hex');
  return join(DATA_DIR, 'revisions', `${encoded}.${String(revision).padStart(6, '0')}.json`);
}

async function readProfile(userId: string): Promise<StoredProfile | undefined> {
  try {
    return JSON.parse(await readFile(profilePath(userId), 'utf8')) as StoredProfile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeProfile(userId: string, profile: StoredProfile): Promise<void> {
  await mkdir(join(DATA_DIR, 'revisions'), { recursive: true });
  await writeFile(profilePath(userId), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  await writeFile(revisionPath(userId, profile.revision), `${JSON.stringify(profile, null, 2)}\n`, {
    mode: 0o600,
  });
  await pruneRevisions(userId);
}

/** Revision history is bounded; an unbounded log is a storage leak, not a safety net. */
async function pruneRevisions(userId: string): Promise<void> {
  const encoded = Buffer.from(userId, 'utf8').toString('hex');
  const dir = join(DATA_DIR, 'revisions');
  try {
    const files = (await readdir(dir)).filter((file) => file.startsWith(`${encoded}.`)).sort();
    const excess = files.slice(0, Math.max(0, files.length - MAX_REVISIONS));
    const { rm } = await import('node:fs/promises');
    for (const file of excess) await rm(join(dir, file), { force: true });
  } catch {
    // A missing revisions directory simply means there is nothing to prune.
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorize(request: IncomingMessage): boolean {
  const expected = process.env['AGENTPASS_API_TOKEN'];
  if (!expected) return true;
  return request.headers.authorization === `Bearer ${expected}`;
}

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EncryptedEnvelope>;
  return (
    candidate.v === 1 &&
    typeof candidate.userId === 'string' &&
    typeof candidate.revision === 'number' &&
    typeof candidate.contentHash === 'string' &&
    typeof candidate.body === 'object' &&
    candidate.body !== null
  );
}

function isKeyring(value: unknown): value is Keyring {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Keyring>;
  return (
    candidate.v === 1 &&
    typeof candidate.keyId === 'string' &&
    typeof candidate.kdf === 'object' &&
    candidate.kdf !== null &&
    typeof candidate.wrappedKey === 'object' &&
    candidate.wrappedKey !== null
  );
}

const server = createServer(async (request, response) => {
  try {
    if (!authorize(request)) return send(response, 401, { error: 'unauthorized' });

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? HOST}`);

    if (url.pathname === '/health') {
      return send(response, 200, { ok: true });
    }

    const match = url.pathname.match(/^\/v1\/profiles\/([^/]+)$/);
    if (!match) return send(response, 404, { error: 'not found' });

    const userId = decodeURIComponent(match[1] as string);

    if (request.method === 'GET') {
      const stored = await readProfile(userId);
      if (!stored) return send(response, 404, { error: 'no profile' });
      return send(response, 200, stored);
    }

    if (request.method === 'PUT') {
      const body = (await readBody(request)) as
        { envelope?: unknown; keyring?: unknown } | undefined;
      if (!body || !isEnvelope(body.envelope)) {
        return send(response, 400, { error: 'expected { envelope }' });
      }
      if (!isKeyring(body.keyring)) {
        return send(response, 400, { error: 'expected { keyring }' });
      }
      const envelope = body.envelope;
      const keyring = body.keyring;
      if (envelope.userId !== userId) {
        return send(response, 400, { error: 'envelope user does not match path' });
      }

      const current = await readProfile(userId);
      // Reject stale writes so a device that has not merged cannot clobber newer state.
      if (current && envelope.revision < current.revision) {
        return send(response, 409, {
          error: 'stale revision',
          current: current.revision,
        });
      }
      // The data key is the account. Silently accepting a different one would lock every
      // other device out of its own profile.
      if (current && current.keyring.keyId !== keyring.keyId) {
        return send(response, 409, { error: 'keyring mismatch for this account' });
      }

      const stored: StoredProfile = {
        envelope,
        keyring,
        revision: envelope.revision,
        updatedAt: new Date().toISOString(),
      };
      await writeProfile(userId, stored);
      return send(response, 200, stored);
    }

    return send(response, 405, { error: 'method not allowed' });
  } catch (error) {
    send(response, 500, { error: (error as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Agent Passport sync API on http://${HOST}:${PORT}\n`);
  process.stdout.write(`Storing encrypted profiles in ${DATA_DIR}\n`);
});
