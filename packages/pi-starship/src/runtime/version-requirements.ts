import { gte, satisfies, valid, validRange } from "semver";

const MAX_REQUIREMENT_LENGTH = 256;
const MAX_VERSION_LENGTH = 80;

/** Invalid or unavailable metadata is not evidence that a runtime is incapable. */
export function nodeRequirementSatisfied(version: string | undefined, requirement: string | undefined): boolean {
  if (!version || !requirement || version.length > MAX_VERSION_LENGTH) return true;
  if (requirement.length > MAX_REQUIREMENT_LENGTH || !/^[0-9A-Za-z.+*|<>=^~ \t-]+$/u.test(requirement)) {
    return true;
  }
  const normalized = valid(version);
  const range = validRange(requirement);
  return !normalized || !range || satisfies(normalized, range);
}

export function goRequirementSatisfied(version: string | undefined, requirement: string | undefined): boolean {
  if (!version || !requirement) return true;
  const installed = completeGoVersion(version);
  const minimum = completeGoVersion(requirement);
  // Go's directive is a minimum, not Rust semver's implicit caret requirement.
  return !installed || !minimum || gte(installed, minimum);
}

function completeGoVersion(value: string): string | undefined {
  if (value.length > MAX_VERSION_LENGTH) return undefined;
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) return undefined;
  return valid(`${match[1]}.${match[2]}.${match[3] ?? "0"}`) ?? undefined;
}
