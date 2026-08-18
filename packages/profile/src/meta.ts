import type { FieldMeta, UniversalProfile } from './schema.js';

export interface StampOptions {
  sourceDevice: string;
  sourceAgent: string;
  now?: string;
}

/**
 * Record that `path` changed, bumping its version.
 *
 * Mutates in place: callers own a freshly parsed profile, and threading an immutable
 * copy through every adapter would cost more than it buys here.
 */
export function stampField(
  profile: UniversalProfile,
  path: string,
  options: StampOptions,
): FieldMeta {
  const previous = profile.meta[path];
  const meta: FieldMeta = {
    version: (previous?.version ?? 0) + 1,
    updatedAt: options.now ?? new Date().toISOString(),
    sourceDevice: options.sourceDevice,
    sourceAgent: options.sourceAgent,
  };
  profile.meta[path] = meta;
  return meta;
}

/** Drop metadata for paths that no longer exist, so `meta` cannot grow without bound. */
export function pruneMeta(profile: UniversalProfile, livePaths: Iterable<string>): void {
  const live = new Set(livePaths);
  for (const path of Object.keys(profile.meta)) {
    if (!live.has(path)) delete profile.meta[path];
  }
}
