import { parse, stringify } from 'yaml';
import { parseProfile, type UniversalProfile } from './schema.js';

/** Render a profile as the `agent-profile.yaml` interchange document. */
export function profileToYaml(profile: UniversalProfile): string {
  return stringify(profile, { lineWidth: 100, sortMapEntries: false });
}

export function profileFromYaml(text: string): UniversalProfile {
  return parseProfile(parse(text));
}
