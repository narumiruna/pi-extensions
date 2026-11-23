import type { EffectiveIgnorePolicy, Snapshot } from "../snapshot/snapshot-types.js";
import { RULES_SNAPSHOT_VERSION } from "../snapshot/snapshot-types.js";
import {
  compileIgnoreRules,
  DEFAULT_IGNORE_FILENAME,
  type IgnoreSource,
  ignorePolicyFingerprint,
  ignoreSourceDigest,
  validateIgnoreFilename,
} from "./ignore-source.js";

type RulesEnvelope = Pick<Snapshot, "version" | "selection" | "ignoreRules">;

export function validateSnapshotIgnoreRules(snapshot: RulesEnvelope): EffectiveIgnorePolicy | undefined {
  if (snapshot.version !== RULES_SNAPSHOT_VERSION) {
    if (Object.hasOwn(snapshot, "ignoreRules")) throw new Error("Unexpected snapshot ignore rules.");
    return;
  }
  const selection = snapshot.selection;
  if (selection?.version !== 4 || !Object.hasOwn(snapshot, "ignoreRules"))
    throw new Error("Missing snapshot ignore policy.");
  const rules = snapshot.ignoreRules;
  if (rules === null) return;
  if (
    !rules ||
    typeof rules !== "object" ||
    !Object.hasOwn(rules, "text") ||
    !Object.hasOwn(rules, "filename") ||
    Object.keys(rules).length !== 2 ||
    typeof rules.text !== "string"
  )
    throw new Error("Invalid snapshot ignore rules.");
  const filename = validateIgnoreFilename(rules.filename);
  const matches = compileIgnoreRules(rules.text);
  if (matches(filename) || ignorePolicyFingerprint(rules.text, selection.sessions) !== selection.fingerprint)
    throw new Error("Snapshot ignore rules do not match the published policy.");
  return {
    filename,
    fingerprint: selection.fingerprint,
    sessions: selection.sessions,
    sourceDigest: ignoreSourceDigest(filename, true, Buffer.from(rules.text)),
    reservedNames: [...new Set([DEFAULT_IGNORE_FILENAME, filename.toLowerCase()])].sort(),
    matches,
  };
}

export function selectSnapshotIgnoreRules(source: IgnoreSource, policy: EffectiveIgnorePolicy) {
  if (!source.present || source.filename !== policy.filename || source.sourceDigest !== policy.sourceDigest)
    throw new Error("Ignore file changed before publication; reopen the review.");
  return policy.matches(source.filename) ? null : { filename: source.filename, text: source.text };
}
