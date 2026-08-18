import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * scrypt parameters. 2^15 rounds keeps an interactive CLI unlock under roughly a
 * second on ordinary hardware while still costing an attacker ~32MB per guess.
 */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

export interface SealedBox {
  v: 1;
  alg: 'AES-256-GCM';
  iv: string;
  ct: string;
  tag: string;
}

/**
 * Authenticated encryption with associated data.
 *
 * `aad` is bound into the tag but not encrypted: pass a context string so a ciphertext
 * lifted from one slot cannot be replayed into another.
 */
export function seal(key: Buffer, plaintext: string | Buffer, aad?: string): SealedBox {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final(),
  ]);
  return {
    v: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function open(key: Buffer, box: SealedBox, aad?: string): Buffer {
  assertKey(key);
  if (box.v !== 1 || box.alg !== 'AES-256-GCM') {
    throw new Error(`unsupported sealed box: v${box.v} ${box.alg}`);
  }
  const tag = Buffer.from(box.tag, 'base64');
  if (tag.length !== TAG_BYTES) throw new Error('invalid authentication tag');

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]);
  } catch {
    throw new Error('decryption failed: wrong key or tampered data');
  }
}

export function openText(key: Buffer, box: SealedBox, aad?: string): string {
  return open(key, box, aad).toString('utf8');
}

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, SCRYPT_PARAMS);
}

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes, received ${key.length}`);
  }
}
