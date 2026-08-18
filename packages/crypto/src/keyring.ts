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

const SLOT_AAD = 'agentpass/keyslot/v2';

export type SlotType = 'passphrase' | 'recovery' | 'device';

export interface KdfParams {
  name: 'scrypt';
  salt: string;
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

export interface KeySlot {
  id: string;
  type: SlotType;
  /** Shown to the user, e.g. "MacBook Pro" or "Recovery code". */
  label: string;
  createdAt: string;
  /** Present when the slot is opened by something the user types. */
  kdf?: KdfParams;
  wrapped: SealedBox;
}

/**
 * A set of independent ways to unlock the same data key.
 *
 * A single passphrase is the wrong shape for this product. Asking an ordinary person to
 * invent, remember, and never lose a string that decrypts their whole identity guarantees
 * that some of them lose everything, and it makes daily use feel like work.
 *
 * Slots split the two jobs a passphrase was doing badly at once. A device slot, backed by
 * the operating system's credential store, makes everyday unlocking invisible. A recovery
 * slot, written down once, is what carries the account to a new machine. Both wrap the same
 * key, so the server still never sees anything it can open.
 */
export interface Keyring {
  v: 2;
  keyId: string;
  slots: KeySlot[];
  createdAt: string;
}

export function createKeyring(): { keyring: Keyring; dataKey: Buffer } {
  const dataKey = randomKey();
  return {
    dataKey,
    keyring: {
      v: 2,
      keyId: keyIdFor(dataKey),
      slots: [],
      createdAt: new Date().toISOString(),
    },
  };
}

/** Non-secret identifier for a data key, used to detect a key/profile mismatch. */
export function keyIdFor(dataKey: Buffer): string {
  return createHash('sha256').update('agentpass/keyid').update(dataKey).digest('hex').slice(0, 16);
}

function wrapWithDerived(dataKey: Buffer, secret: string): { kdf: KdfParams; wrapped: SealedBox } {
  const salt = randomBytes(16);
  return {
    kdf: {
      name: 'scrypt',
      salt: salt.toString('base64'),
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      keyLen: KEY_BYTES,
    },
    wrapped: seal(deriveKey(secret, salt), dataKey, SLOT_AAD),
  };
}

function addSlot(keyring: Keyring, slot: KeySlot): Keyring {
  return { ...keyring, slots: [...keyring.slots.filter((s) => s.id !== slot.id), slot] };
}

export function addPassphraseSlot(
  keyring: Keyring,
  dataKey: Buffer,
  passphrase: string,
  label = 'Passphrase',
): Keyring {
  const { kdf, wrapped } = wrapWithDerived(dataKey, passphrase);
  return addSlot(keyring, {
    id: 'passphrase',
    type: 'passphrase',
    label,
    createdAt: new Date().toISOString(),
    kdf,
    wrapped,
  });
}

export interface RecoverySlotResult {
  keyring: Keyring;
  /** Shown to the user exactly once. Never stored anywhere by Agent Passport. */
  code: string;
}

export function addRecoverySlot(keyring: Keyring, dataKey: Buffer): RecoverySlotResult {
  const code = generateRecoveryCode();
  const { kdf, wrapped } = wrapWithDerived(dataKey, normalizeRecoveryCode(code));
  return {
    code,
    keyring: addSlot(keyring, {
      id: 'recovery',
      type: 'recovery',
      label: 'Recovery code',
      createdAt: new Date().toISOString(),
      kdf,
      wrapped,
    }),
  };
}

/**
 * Bind the data key to a key held by this machine's credential store.
 *
 * The wrapping key never leaves the device, so this slot is useless to anyone who obtains
 * the synced keyring. It exists so the common case — unlocking on a machine already set up —
 * asks the user for nothing at all.
 */
export function addDeviceSlot(
  keyring: Keyring,
  dataKey: Buffer,
  deviceKey: Buffer,
  label: string,
  deviceId: string,
): Keyring {
  return addSlot(keyring, {
    id: deviceSlotId(deviceId),
    type: 'device',
    label,
    createdAt: new Date().toISOString(),
    wrapped: seal(deviceKey, dataKey, SLOT_AAD),
  });
}

export function removeSlot(keyring: Keyring, id: string): Keyring {
  return { ...keyring, slots: keyring.slots.filter((slot) => slot.id !== id) };
}

export function hasSlot(keyring: Keyring, id: string): boolean {
  return keyring.slots.some((slot) => slot.id === id);
}

export function deviceSlotId(deviceId: string): string {
  return `device:${deviceId}`;
}

export class UnlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnlockError';
  }
}

function openSlot(slot: KeySlot, key: Buffer, keyring: Keyring): Buffer {
  const dataKey = open(key, slot.wrapped, SLOT_AAD);
  if (keyIdFor(dataKey) !== keyring.keyId) {
    throw new UnlockError('this key does not belong to this account');
  }
  return dataKey;
}

export function unlockWithPassphrase(keyring: Keyring, passphrase: string): Buffer {
  return unlockDerived(keyring, 'passphrase', passphrase, 'That passphrase is not correct.');
}

export function unlockWithRecoveryCode(keyring: Keyring, code: string): Buffer {
  return unlockDerived(
    keyring,
    'recovery',
    normalizeRecoveryCode(code),
    'That recovery code is not correct.',
  );
}

function unlockDerived(keyring: Keyring, id: string, secret: string, failure: string): Buffer {
  const slot = keyring.slots.find((candidate) => candidate.id === id);
  if (!slot?.kdf) throw new UnlockError(`this account has no ${id} set up`);
  try {
    return openSlot(slot, deriveKey(secret, Buffer.from(slot.kdf.salt, 'base64')), keyring);
  } catch (error) {
    if (error instanceof UnlockError) throw error;
    throw new UnlockError(failure);
  }
}

export function unlockWithDeviceKey(keyring: Keyring, deviceKey: Buffer, deviceId: string): Buffer {
  const slot = keyring.slots.find((candidate) => candidate.id === deviceSlotId(deviceId));
  if (!slot) throw new UnlockError('this device is not set up yet');
  try {
    return openSlot(slot, deviceKey, keyring);
  } catch (error) {
    if (error instanceof UnlockError) throw error;
    throw new UnlockError('this device key no longer works');
  }
}

/**
 * Crockford base32 without I, L, O, and U.
 *
 * A recovery code gets written on paper and typed back months later, so the alphabet
 * excludes characters people confuse with each other, and reading is case-insensitive.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 5;
const GROUP_SIZE = 4;

export function generateRecoveryCode(): string {
  const bytes = randomBytes(GROUPS * GROUP_SIZE);
  const chars = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i += 1) {
    groups.push(chars.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE));
  }
  return groups.join('-');
}

/** Accept whatever the user types: lowercase, missing dashes, stray spaces, lookalikes. */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export function formatRecoveryCode(code: string): string {
  const clean = normalizeRecoveryCode(code);
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += GROUP_SIZE) {
    groups.push(clean.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

export function isRecoveryCodeShaped(code: string): boolean {
  return normalizeRecoveryCode(code).length === GROUPS * GROUP_SIZE;
}

/**
 * Union the slots of two copies of the same keyring.
 *
 * Every machine adds its own device slot, so two computers that sync in sequence each hold
 * a keyring the other has not seen. Overwriting instead of merging would drop the other
 * machine's slot and silently demand its recovery code again — the exact failure that makes
 * people distrust sync. Slot ids are stable, so a union converges.
 */
export function mergeKeyrings(local: Keyring, remote: Keyring): Keyring {
  if (local.keyId !== remote.keyId) return local;

  const slots = new Map<string, KeySlot>();
  for (const slot of [...remote.slots, ...local.slots]) {
    const existing = slots.get(slot.id);
    if (!existing || slot.createdAt > existing.createdAt) slots.set(slot.id, slot);
  }

  return { ...local, slots: [...slots.values()] };
}
