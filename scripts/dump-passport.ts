/**
 * Print everything a passport holds, decrypted.
 *
 * Written as a diagnostic rather than documentation: a list of fields in a README drifts
 * from the code, whereas this dumps whatever is actually on disk right now.
 */
import { Passport } from '@agentpassport/core';

const passport = await Passport.open();
if (!(await passport.store.exists())) {
  process.stdout.write('No passport on this computer.\n');
  process.exit(1);
}

const session = await passport.store.session();
const keyring = await passport.store.keyring();
const history = await passport.store.history();
const { dataKey } = await passport.store.unlock();
const profile = await passport.store.load(dataKey);
const memories = await passport.store.loadMemories(dataKey);

process.stdout.write(
  `${JSON.stringify(
    {
      readableWithoutTheKey: {
        session,
        keySlots: keyring.slots.map((slot) => ({
          id: slot.id,
          type: slot.type,
          label: slot.label,
        })),
        revisionLog: history,
      },
      encrypted: { profile, memories },
    },
    null,
    2,
  )}\n`,
);
