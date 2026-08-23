import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createKeyring,
  addRecoverySlot,
  addPassphraseSlot,
  addDeviceSlot,
  unlockWithRecoveryCode,
  unlockWithPassphrase,
  unlockWithDeviceKey,
  hasSlot,
  deviceSlotId,
  UnlockError,
} from '@agentpassport/crypto';
import { randomBytes } from 'node:crypto';

test('createKeyring produces a keyring + fresh data key', () => {
  const { keyring, dataKey } = createKeyring();
  assert.ok(Buffer.isBuffer(dataKey));
  assert.equal(dataKey.length, 32);
  assert.ok(Array.isArray(keyring.slots));
  assert.equal(keyring.slots.length, 0);
});

test('recovery-code slot: same dataKey round-trips', () => {
  const { keyring, dataKey } = createKeyring();
  const { keyring: k2, code } = addRecoverySlot(keyring, dataKey);
  const unlocked = unlockWithRecoveryCode(k2, code);
  assert.equal(unlocked.toString('hex'), dataKey.toString('hex'));
});

test('passphrase slot: same dataKey round-trips', () => {
  const { keyring, dataKey } = createKeyring();
  const k2 = addPassphraseSlot(keyring, dataKey, 'hunter2-open-sesame');
  const unlocked = unlockWithPassphrase(k2, 'hunter2-open-sesame');
  assert.equal(unlocked.toString('hex'), dataKey.toString('hex'));
});

test('wrong passphrase throws UnlockError', () => {
  const { keyring, dataKey } = createKeyring();
  const k2 = addPassphraseSlot(keyring, dataKey, 'right');
  assert.throws(() => unlockWithPassphrase(k2, 'wrong'), UnlockError);
});

test('device slot: dataKey round-trips with the wrapping key', () => {
  const { keyring, dataKey } = createKeyring();
  const deviceKey = randomBytes(32);
  const k2 = addDeviceSlot(keyring, dataKey, deviceKey, 'laptop', 'device-abc');
  assert.ok(hasSlot(k2, deviceSlotId('device-abc')));
  const unlocked = unlockWithDeviceKey(k2, deviceKey, 'device-abc');
  assert.equal(unlocked.toString('hex'), dataKey.toString('hex'));
});

test('device slot rejects the wrong wrapping key', () => {
  const { keyring, dataKey } = createKeyring();
  const k2 = addDeviceSlot(keyring, dataKey, randomBytes(32), 'laptop', 'device-x');
  assert.throws(
    () => unlockWithDeviceKey(k2, randomBytes(32), 'device-x'),
    UnlockError,
  );
});
