import { createHash } from 'node:crypto';
import { openText, seal, type SealedBox } from './cipher.js';

/**
 * What the server is allowed to see.
 *
 * Routing and conflict detection need an owner, an ordering, and a change detector, and
 * nothing else. Everything with user meaning lives inside `body`, so a full database
 * compromise yields ciphertext plus the fact that a user syncs.
 */
export interface EncryptedEnvelope {
  v: 1;
  userId: string;
  keyId: string;
  revision: number;
  updatedAt: string;
  /** SHA-256 of the plaintext, letting a client detect a no-op sync without decrypting twice. */
  contentHash: string;
  body: SealedBox;
}

export interface SealEnvelopeInput {
  userId: string;
  keyId: string;
  revision: number;
  plaintext: string;
  updatedAt?: string;
}

export function sealEnvelope(dataKey: Buffer, input: SealEnvelopeInput): EncryptedEnvelope {
  const aad = envelopeAad(input.userId, input.revision);
  return {
    v: 1,
    userId: input.userId,
    keyId: input.keyId,
    revision: input.revision,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    contentHash: createHash('sha256').update(input.plaintext).digest('hex'),
    body: seal(dataKey, input.plaintext, aad),
  };
}

export function openEnvelope(dataKey: Buffer, envelope: EncryptedEnvelope): string {
  if (envelope.v !== 1) throw new Error(`unsupported envelope version ${envelope.v}`);
  const plaintext = openText(
    dataKey,
    envelope.body,
    envelopeAad(envelope.userId, envelope.revision),
  );
  const actual = createHash('sha256').update(plaintext).digest('hex');
  if (actual !== envelope.contentHash) {
    throw new Error('envelope content hash mismatch');
  }
  return plaintext;
}

/**
 * Binding the revision into the AAD stops a server from rolling a user back by serving an
 * older ciphertext under a newer revision number.
 */
function envelopeAad(userId: string, revision: number): string {
  return `agentpass/envelope/v1|${userId}|${revision}`;
}
