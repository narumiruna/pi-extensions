import type { EffectiveIgnorePolicy } from "../snapshot/snapshot-types.js";
import {
  compileIgnoreRules,
  DEFAULT_IGNORE_FILENAME,
  type IgnoreSource,
  ignorePolicyFingerprint,
  readIgnoreSource,
  validateIgnoreFilename,
} from "./ignore-source.js";

export interface IgnorePolicyInput {
  filename?: string;
  sessions: boolean;
  configuredFilenames: readonly string[];
}

function reservedNames(filename: string, configuredFilenames: readonly string[]) {
  return [
    ...new Set(
      [DEFAULT_IGNORE_FILENAME, filename, ...configuredFilenames].map((name) =>
        validateIgnoreFilename(name).toLowerCase(),
      ),
    ),
  ].sort();
}

export async function loadEffectiveIgnorePolicy(
  root: string,
  input: IgnorePolicyInput,
  signal?: AbortSignal,
): Promise<EffectiveIgnorePolicy> {
  const source = await readIgnoreSource(root, input.filename, signal);
  signal?.throwIfAborted();
  return compileEffectiveIgnorePolicy(source, input);
}

export function compileEffectiveIgnorePolicy(source: IgnoreSource, input: IgnorePolicyInput): EffectiveIgnorePolicy {
  return {
    filename: source.filename,
    sourceDigest: source.sourceDigest,
    fingerprint: ignorePolicyFingerprint(source.text, input.sessions),
    sessions: input.sessions,
    reservedNames: reservedNames(source.filename, input.configuredFilenames),
    matches: compileIgnoreRules(source.text),
  };
}

export async function requireUnchangedIgnorePolicy(
  root: string,
  reviewed: EffectiveIgnorePolicy,
  current: IgnorePolicyInput,
  signal?: AbortSignal,
) {
  const source = await readIgnoreSource(root, current.filename, signal);
  signal?.throwIfAborted();
  const currentNames = reservedNames(source.filename, current.configuredFilenames);
  if (
    reviewed.filename !== source.filename ||
    reviewed.sourceDigest !== source.sourceDigest ||
    reviewed.sessions !== current.sessions ||
    reviewed.reservedNames.length !== currentNames.length ||
    reviewed.reservedNames.some((name, index) => name !== currentNames[index])
  ) {
    throw new Error("Pi Sync ignore policy changed; reopen the review before continuing.");
  }
}
