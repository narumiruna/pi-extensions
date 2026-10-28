import { dirname, join, resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { getManagedSkills, type ManagedSkill } from "../managed-skills.ts";
import type { LocalSkill } from "../types.ts";

// Importing the pure merge must not load filesystem operations or the inventory scanner.
vi.mock("node:fs", () => {
  throw new Error("The managed-skill merge must not import node:fs");
});
vi.mock("node:fs/promises", () => {
  throw new Error("The managed-skill merge must not import node:fs/promises");
});
vi.mock("../filesystem.ts", () => {
  throw new Error("The managed-skill merge must not import the inventory scanner");
});

function local(path = "/skills/zeta", overrides: Partial<LocalSkill> = {}): LocalSkill {
  return {
    id: resolve(path),
    path,
    directoryPath: path,
    name: "Disk name",
    description: "Disk description",
    location: { id: "user", label: "User", path: "/skills", scope: "user" },
    content: "---\nname: zeta\ndescription: Disk description\n---\n",
    warnings: [],
    fingerprint: "disk-fingerprint",
    ...overrides,
  };
}

function native(filePath = "/skills/zeta/SKILL.md", overrides: Partial<Skill> = {}): Skill {
  return {
    name: "Native name",
    description: "Native description",
    filePath,
    baseDir: dirname(filePath),
    disableModelInvocation: false,
    sourceInfo: { path: filePath, source: "local", origin: "top-level", scope: "user" },
    ...overrides,
  };
}

function freezeLocal(skill: LocalSkill): LocalSkill {
  Object.freeze(skill.location);
  Object.freeze(skill.warnings);
  return Object.freeze(skill);
}

function freezeNative(skill: Skill): Skill {
  Object.freeze(skill.sourceInfo);
  return Object.freeze(skill);
}

describe("getManagedSkills", () => {
  it("merges an exact bundle match with local fields and both original references", () => {
    const disk = local();
    const loaded = native(undefined, { baseDir: "/different-native-base" });
    const rows: ManagedSkill[] = getManagedSkills([disk], [loaded]);
    expect(rows).toEqual([
      {
        id: "/skills/zeta/SKILL.md",
        filePath: "/skills/zeta/SKILL.md",
        directoryPath: disk.directoryPath,
        name: disk.name,
        description: disk.description,
        local: disk,
        loaded,
      },
    ]);
    expect(rows[0].local).toBe(disk);
    expect(rows[0].loaded).toBe(loaded);
    expect(rows[0].loaded?.name).toBe("Native name");
  });

  it("matches a standalone Markdown file without appending SKILL.md", () => {
    const disk = local("/skills/standalone.md", {
      directoryPath: "/skills",
      readOnlyReason: "Standalone Markdown skills are read-only",
    });
    const loaded = native(disk.path);
    const [row] = getManagedSkills([disk], [loaded]);
    expect(row.filePath).toBe(disk.path);
    expect(row.id).toBe(resolve(disk.path));
    expect(row.directoryPath).toBe("/skills");
    expect(row.local).toBe(disk);
    expect(row.loaded).toBe(loaded);
  });

  it("uses the inventory encoding for a bundle directory named *.md", () => {
    const disk = local("/skills/bundle.md", { directoryPath: "/skills/./bundle.md" });
    const loaded = native("/skills/bundle.md/SKILL.md");
    const rows = getManagedSkills([disk], [loaded]);
    expect(rows).toHaveLength(1);
    expect(rows[0].filePath).toBe(join(disk.path, "SKILL.md"));
    expect(rows[0].directoryPath).toBe(disk.directoryPath);
    expect(rows[0].loaded).toBe(loaded);
  });

  it("does not merge equal names at different file paths", () => {
    const disk = local("/skills/first", { name: "Same" });
    const loaded = native("/skills/second/SKILL.md", { name: "Same" });
    const rows = getManagedSkills([disk], [loaded]);
    expect(rows.map((row) => row.id)).toEqual(["/skills/first/SKILL.md", loaded.filePath]);
    expect(rows[0].loaded).toBeUndefined();
    expect(rows[1].local).toBeUndefined();
  });

  it.each([
    { label: "package", filePath: "/npm/example/skills/package/SKILL.md", source: "npm:example" },
    { label: "ancestor", filePath: "/ancestor/.pi/skills/parent/SKILL.md", source: "local" },
    { label: "linked", filePath: "/skills/linked/SKILL.md", source: "local" },
    { label: "standalone", filePath: "/skills/standalone.md", source: "local" },
  ])("retains a native-only $label skill without local authorization", ({ filePath, source, label }) => {
    const loaded = native(filePath, {
      baseDir: "/native/base-dir",
      sourceInfo: {
        path: filePath,
        source,
        origin: label === "package" ? "package" : "top-level",
        scope: "project",
      },
    });
    expect(getManagedSkills([], [loaded])).toEqual([
      {
        id: resolve(filePath),
        filePath,
        directoryPath: loaded.baseDir,
        name: loaded.name,
        description: loaded.description,
        loaded,
      },
    ]);
    expect(getManagedSkills([], [loaded])[0]).not.toHaveProperty("local");
  });

  it("matches normalized lexical paths while retaining the raw local standalone payload", () => {
    const disk = local("skills/unused/../raw.md", { directoryPath: "skills" });
    const loaded = native(resolve("skills/raw.md"));
    const rows = getManagedSkills([disk], [loaded]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(resolve("skills/raw.md"));
    expect(rows[0].filePath).toBe(disk.path);
    expect(rows[0].directoryPath).toBe(disk.directoryPath);
    expect(rows[0].loaded).toBe(loaded);
  });

  it("does not guess that distinct lexical alias paths share a canonical target", () => {
    const disk = local("/real/skill", { readOnlyReason: "Symbolic link directory is read-only" });
    const alias = native("/linked/skill/SKILL.md");
    const rows = getManagedSkills([disk], [alias]);
    expect(rows.map((row) => row.id)).toEqual(["/real/skill/SKILL.md", "/linked/skill/SKILL.md"]);
    expect(rows[0].local).toBe(disk);
    expect(rows[0].loaded).toBeUndefined();
    expect(rows[1].local).toBeUndefined();
    expect(rows[1].loaded).toBe(alias);
  });

  it("preserves the first local and first loaded object for duplicate normalized file IDs", () => {
    const firstLocal = local();
    const secondLocal = local("/skills/./zeta", {
      id: "different-inventory-id",
      name: "Later disk name",
      warnings: ["Later warning"],
      fingerprint: "later-fingerprint",
      readOnlyReason: "Later read-only reason",
    });
    const firstLoaded = native();
    const secondLoaded = native("/skills/zeta/../zeta/SKILL.md", { name: "Later loaded name" });
    const firstOnly = native("/only/./SKILL.md");
    const secondOnly = native("/only/SKILL.md", { description: "Later description" });
    const rows = getManagedSkills(
      [firstLocal, secondLocal, firstLocal],
      [firstLoaded, secondLoaded, firstOnly, secondOnly],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].local).toBe(firstLocal);
    expect(rows[0].loaded).toBe(firstLoaded);
    expect(rows[0].name).toBe(firstLocal.name);
    expect(rows[1].loaded).toBe(firstOnly);
    expect(rows[1].filePath).toBe(firstOnly.filePath);
    expect(rows[1].description).toBe(firstOnly.description);
  });

  it("retains malformed local metadata, warnings, location, read-only reason, and fingerprint", () => {
    const disk = local(undefined, {
      name: "",
      description: "",
      content: "---\nmalformed: [\n",
      warnings: ["Invalid frontmatter", "Missing description"],
      readOnlyReason: "Unsafe skill tree",
      fingerprint: "opaque-identity:digest:false",
      location: {
        id: "custom",
        label: "Read-only location",
        path: "/skills",
        scope: "custom",
        readOnlyReason: "Location is read-only",
      },
    });
    const [row] = getManagedSkills([disk], [native()]);
    expect(row.name).toBe("");
    expect(row.description).toBe("");
    expect(row.local).toBe(disk);
    expect(row.local?.warnings).toBe(disk.warnings);
    expect(row.local?.location).toBe(disk.location);
    expect(row.local?.content).toBe(disk.content);
    expect(row.local?.fingerprint).toBe(disk.fingerprint);
    expect(row.local?.readOnlyReason).toBe(disk.readOnlyReason);
  });

  it("keeps inventory order before appended native-only rows without sorting", () => {
    const disks = [local("/skills/zeta"), local("/skills/alpha")];
    const loaded = [native("/skills/beta/SKILL.md"), native(), native("/skills/alpha/SKILL.md")];
    expect(getManagedSkills(disks, loaded).map((row) => row.id)).toEqual([
      "/skills/zeta/SKILL.md",
      "/skills/alpha/SKILL.md",
      "/skills/beta/SKILL.md",
    ]);
  });

  it("does not mutate frozen input arrays, objects, or nested metadata", () => {
    const disks = Object.freeze([freezeLocal(local()), freezeLocal(local("/skills/alpha"))]);
    const loaded = Object.freeze([freezeNative(native()), freezeNative(native("/native/only.md"))]);
    const before = structuredClone({ disks, loaded });
    const rows = getManagedSkills(disks, loaded);
    expect(rows).toHaveLength(3);
    expect({ disks, loaded }).toEqual(before);
    expect(rows[0].local).toBe(disks[0]);
    expect(rows[0].loaded).toBe(loaded[0]);
    expect(getManagedSkills(disks, loaded)).toEqual(rows);
  });

  it("retains control-bearing raw paths, metadata, and normalized IDs without display transformations", () => {
    const control = "\u001b]0;raw\u0007\n\u202e";
    const disk = local(`/skills/${control}/standalone.md`, {
      directoryPath: `/skills/${control}`,
      name: `Disk ${control}`,
      description: `Description ${control}`,
    });
    const loaded = native(`native/${control}/../${control}/only.md`, { baseDir: `native/${control}` });
    const rows = getManagedSkills([disk], [loaded]);
    expect(rows[0].id).toBe(resolve(disk.path));
    expect(rows[0].filePath).toBe(disk.path);
    expect(rows[0].directoryPath).toBe(disk.directoryPath);
    expect(rows[0].name).toBe(disk.name);
    expect(rows[0].description).toBe(disk.description);
    expect(rows[1].id).toBe(resolve(loaded.filePath));
    expect(rows[1].filePath).toBe(loaded.filePath);
    expect(rows[1].directoryPath).toBe(loaded.baseDir);
  });

  it("returns an empty result for empty inputs without filesystem imports", () => {
    expect(getManagedSkills([], [])).toEqual([]);
  });
});
