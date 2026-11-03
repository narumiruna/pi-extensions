import { join, resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { LocalSkill } from "./types.ts";

export interface ManagedSkill {
  id: string;
  filePath: string;
  directoryPath: string;
  name: string;
  description: string;
  local?: LocalSkill;
  loaded?: Skill;
}

/** Merge disk inventory and native loaded skills by lexical skill-file identity. */
export function getManagedSkills(inventory: readonly LocalSkill[], loaded: readonly Skill[]): ManagedSkill[] {
  const rows = new Map<string, ManagedSkill>();
  for (const local of inventory) {
    // scanInventory uses equal paths for bundles, including directories named *.md.
    const filePath = resolve(local.path) === resolve(local.directoryPath) ? join(local.path, "SKILL.md") : local.path;
    const id = resolve(filePath);
    if (rows.has(id)) continue;
    rows.set(id, {
      id,
      filePath,
      directoryPath: local.directoryPath,
      name: local.name,
      description: local.description,
      local,
    });
  }
  for (const skill of loaded) {
    const id = resolve(skill.filePath);
    const row = rows.get(id);
    if (row) {
      row.loaded ??= skill;
    } else {
      rows.set(id, {
        id,
        filePath: skill.filePath,
        directoryPath: skill.baseDir,
        name: skill.name,
        description: skill.description,
        loaded: skill,
      });
    }
  }
  return [...rows.values()];
}
