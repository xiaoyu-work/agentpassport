import {
  classify,
  looksLikeSecret,
  selectForAgent,
  type MemoryDraft,
  type MemoryRecord,
} from '@agentpass/memory';
import { contentHash, type UniversalProfile } from '@agentpass/profile';
import {
  appendRevision,
  diffProfiles,
  mergeProfiles,
  type Conflict,
  type ProfileDiff,
  type Revision,
  type Side,
} from '@agentpass/sync';
import type { AdapterWarning, AgentConfigDiff } from '@agentpass/adapter-sdk';
import type { Passport } from './passport.js';
import { mergeMemories } from './vault-memory.js';
import { ConflictError, NullRemoteStore } from './remote.js';

export interface ImportOptions {
  agent: string;
  /** Preview only: compute everything, write nothing. */
  dryRun?: boolean;
}

export interface ImportOutcome {
  agent: string;
  diff: ProfileDiff;
  /** Memories accepted into the shared store. */
  accepted: MemoryRecord[];
  /** Memories held back pending review, with the reason. */
  held: Array<{ draft: MemoryDraft; reason: string }>;
  warnings: AdapterWarning[];
  sources: string[];
  applied: boolean;
}

/**
 * Read an agent's configuration into the passport.
 *
 * Config merges into the profile; prose becomes memory candidates. The two travel
 * differently on purpose: config is authoritative and overwritten, memory is a claim about
 * the user that has to earn its place.
 */
export async function importFromAgent(
  passport: Passport,
  options: ImportOptions,
): Promise<ImportOutcome> {
  const adapter = await passport.adapter(options.agent);
  const { dataKey } = await passport.store.unlock();
  const current = await passport.store.load(dataKey);

  const context = passport.context({ dryRun: options.dryRun ?? false });
  if (!(await adapter.detect(context))) {
    throw new Error(`no ${adapter.displayName} configuration found on this machine`);
  }

  const result = await adapter.import(context, current.identity.userId);

  const merged = mergeProfiles(current, result.profile, { strategy: 'remote' });
  const next = merged.profile;
  next.identity.userId = current.identity.userId;
  const diff = diffProfiles(current, next);

  const accepted: MemoryRecord[] = [];
  const held: Array<{ draft: MemoryDraft; reason: string }> = [];
  const provider = passport.memory(next, dataKey);

  const admissible: MemoryDraft[] = [];
  for (const draft of result.memories) {
    if (looksLikeSecret(draft.content)) {
      held.push({ draft, reason: 'looks like credential material' });
      continue;
    }
    const decision = classify(draft);
    if (decision.status === 'quarantined') {
      held.push({ draft, reason: decision.reason });
      continue;
    }
    admissible.push(draft);
  }

  if (!options.dryRun) {
    if (admissible.length > 0) {
      accepted.push(...(await provider.add(current.identity.userId, admissible)));
    }
    const revision: Revision = {
      revision: next.revision,
      hash: contentHash(next),
      updatedAt: next.updatedAt,
      sourceDevice: passport.device,
      sourceAgent: options.agent,
      summary: `imported from ${adapter.displayName}`,
    };
    await passport.store.save(dataKey, next, revision);
  } else {
    for (const draft of admissible) {
      accepted.push({ ...draft, id: draft.id ?? 'pending' } as MemoryRecord);
    }
  }

  return {
    agent: options.agent,
    diff,
    accepted,
    held,
    warnings: result.warnings,
    sources: result.sources,
    applied: !options.dryRun,
  };
}

export interface RestoreOptions {
  agent: string;
  dryRun?: boolean;
}
export interface RestoreOutcome {
  agent: string;
  plan: AgentConfigDiff;
  /** Memories this agent receives: shared ones plus any pinned to it. */
  memories: MemoryRecord[];
  written: string[];
  applied: boolean;
}

/**
 * Write the passport into an agent's native configuration.
 *
 * The memory set is resolved per agent — shared memories plus those pinned to this one —
 * so a new install starts out knowing everything the user has ever established, and
 * nothing that belonged to a different tool.
 */
export async function restoreToAgent(
  passport: Passport,
  options: RestoreOptions,
): Promise<RestoreOutcome> {
  const adapter = await passport.adapter(options.agent);
  const { dataKey } = await passport.store.unlock();
  const profile = await passport.store.load(dataKey);

  const provider = passport.memory(profile, dataKey);
  const all = await provider.list(profile.identity.userId);
  const memories = selectForAgent(all, options.agent, { project: passport.cwd });

  const context = passport.context({ dryRun: options.dryRun ?? false });
  const plan = await adapter.previewExport(context, profile, memories);

  let written: string[] = [];
  if (!options.dryRun) {
    const result = await adapter.export(context, profile, memories);
    written = result.written;
  }

  return { agent: options.agent, plan, memories, written, applied: !options.dryRun };
}

export interface SyncOptions {
  resolutions?: Record<string, Side>;
  strategy?: Side | 'ask';
  dryRun?: boolean;
}

export interface SyncOutcome {
  /** Changes pulled from the cloud into the local profile. */
  pulled: ProfileDiff;
  conflicts: Conflict[];
  pushed: boolean;
  revision: number;
  /** Whether a sync server is configured at all. */
  remoteConfigured: boolean;
  /** Whether the server already held a profile. False on the very first sync. */
  remoteHadProfile: boolean;
}

/**
 * Reconcile local and cloud profiles.
 *
 * Uses the last synced state as a merge ancestor so a field deleted on one device is
 * distinguishable from a field another device never had. Conflicts stop the sync rather
 * than being resolved silently.
 */
export async function syncProfile(passport: Passport, options: SyncOptions): Promise<SyncOutcome> {
  const { dataKey } = await passport.store.unlock();
  const local = await passport.store.load(dataKey);
  const ancestor = await passport.store.loadBase(dataKey);
  const remoteStore = await passport.remote();
  const configured = !(remoteStore instanceof NullRemoteStore);
  const remote = await remoteStore.pull(local.identity.userId);

  if (!remote) {
    // Either no server, or a server that has never seen this user. Publishing local as the
    // starting point is correct in both cases; only the message differs.
    if (!options.dryRun && configured) {
      await remoteStore.push(
        local.identity.userId,
        await passport.store.envelope(),
        await passport.store.keyring(),
      );
      await passport.store.markSynced(dataKey, local);
    }
    return {
      pulled: { entries: [], added: 0, removed: 0, updated: 0 },
      conflicts: [],
      pushed: configured && !options.dryRun,
      revision: local.revision,
      remoteConfigured: configured,
      remoteHadProfile: false,
    };
  }

  const remoteBundle = await passport.store.decodeEnvelope(dataKey, remote.envelope);
  const remoteProfile = remoteBundle.profile;

  // Fold in any device slots this machine has not seen, so syncing never costs another
  // computer its ability to unlock silently.
  if (remote.keyring) await passport.store.mergeKeyring(remote.keyring);

  const merged = mergeProfiles(local, remoteProfile, {
    ...(ancestor ? { ancestor } : {}),
    ...(options.resolutions ? { resolutions: options.resolutions } : {}),
    strategy: options.strategy ?? 'ask',
  });

  const pulled = diffProfiles(local, merged.profile);

  if (merged.conflicts.length > 0) {
    return {
      pulled,
      conflicts: merged.conflicts,
      pushed: false,
      revision: local.revision,
      remoteConfigured: true,
      remoteHadProfile: true,
    };
  }

  if (options.dryRun) {
    return {
      pulled,
      conflicts: [],
      pushed: false,
      revision: merged.profile.revision,
      remoteConfigured: true,
      remoteHadProfile: true,
    };
  }

  const history = appendRevision(await passport.store.history(), merged.profile, {
    sourceDevice: passport.device,
    sourceAgent: 'sync',
    summary: `merged ${pulled.entries.length} change(s) from the cloud`,
  });
  await passport.store.save(dataKey, merged.profile, history.at(-1));

  // Memories merge by union rather than by field, because they are append-mostly and
  // content-addressed: the same fact learned on two machines produces the same id, so a
  // union converges instead of duplicating.
  const localMemories = await passport.store.loadMemories(dataKey);
  await passport.store.saveMemories(dataKey, mergeMemories(localMemories, remoteBundle.memories));

  try {
    await remoteStore.push(
      local.identity.userId,
      await passport.store.envelope(),
      await passport.store.keyring(),
    );
  } catch (error) {
    if (error instanceof ConflictError) {
      return {
        pulled,
        conflicts: [],
        pushed: false,
        revision: merged.profile.revision,
        remoteConfigured: true,
        remoteHadProfile: true,
      };
    }
    throw error;
  }
  await passport.store.markSynced(dataKey, merged.profile);

  return {
    pulled,
    conflicts: [],
    pushed: true,
    revision: merged.profile.revision,
    remoteConfigured: true,
    remoteHadProfile: true,
  };
}

/** Compare an agent's on-disk config with the passport, in both directions. */ export async function diffAgent(
  passport: Passport,
  options: { agent: string },
): Promise<{ incoming: ProfileDiff; outgoing: AgentConfigDiff; profile: UniversalProfile }> {
  const adapter = await passport.adapter(options.agent);
  const { dataKey } = await passport.store.unlock();
  const profile = await passport.store.load(dataKey);
  const context = passport.context({ dryRun: true });

  const imported = await adapter.import(context, profile.identity.userId);
  const wouldBe = mergeProfiles(profile, imported.profile, { strategy: 'remote' }).profile;

  const provider = passport.memory(profile, dataKey);
  const all = await provider.list(profile.identity.userId);
  const memories = selectForAgent(all, options.agent, { project: passport.cwd });

  return {
    incoming: diffProfiles(profile, wouldBe),
    outgoing: await adapter.previewExport(context, profile, memories),
    profile,
  };
}
