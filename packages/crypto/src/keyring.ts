import { createHash, randomBytes } from 'node:crypto';
import {
  KEY_BYTES,
  SCRYPT_PARAMS,
  deriveKey,
  open,
  randomKey,
  seal,
  type SealedBox,
} from './cipher.js';

const KEYRING_AAD = 'agentpass/keyring/v1';

export interface Keyring {
  v: 1;
  keyId: string;
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number; keyLen: number };
  /** The data key, encrypted under the passphrase-derived key. */
  wrappedKey: SealedBox;
  createdAt: string;
}

/**
 * Envelope encryption: a random data key protects the profile, and the passphrase only
 * protects the data key.
 *
 * The indirection means changing a passphrase rewraps 32 bytes instead of re-encrypting
 * every revision, and it keeps the expensive scrypt derivation off the hot path.
 */
export function createKeyring(passphrase: string): { keyring: Keyring; dataKey: Buffer } {
  const salt = randomBytes(16);
  const wrappingKey = deriveKey(passphrase, salt);
  const dataKey = randomKey();
  return {
    dataKey,
    keyring: {
      v: 1,
      keyId: keyIdFor(dataKey),
      kdf: {
        name: 'scrypt',
        salt: salt.toString('base64'),
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
        keyLen: KEY_BYTES,
      },
      wrappedKey: seal(wrappingKey, dataKey, KEYRING_AAD),
      createdAt: new Date().toISOString(),
    },
  };
}

export function unlockKeyring(keyring: Keyring, passphrase: string): Buffer {
  if (keyring.v !== 1 || keyring.kdf.name !== 'scrypt') {
    throw new Error('unsupported keyring format');
  }
  const wrappingKey = deriveKey(passphrase, Buffer.from(keyring.kdf.salt, 'base64'));
  return open(wrappingKey, keyring.wrappedKey, KEYRING_AAD);
}

export function rewrapKeyring(keyring: Keyring, current: string, next: string): Keyring {
  const dataKey = unlockKeyring(keyring, current);
  const salt = randomBytes(16);
  return {
    ...keyring,
    kdf: { ...keyring.kdf, salt: salt.toString('base64') },
    wrappedKey: seal(deriveKey(next, salt), dataKey, KEYRING_AAD),
  };
}

/** Non-secret identifier for a data key, used to detect a passphrase/profile mismatch. */
export function keyIdFor(dataKey: Buffer): string {
  return createHash('sha256').update('agentpass/keyid').update(dataKey).digest('hex').slice(0, 16);
}
