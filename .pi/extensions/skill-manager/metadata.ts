import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { BundleFile, SkillMetadata } from "./types.ts";

function inspectStaged(directoryName: string, stage: (directory: string) => void): SkillMetadata {
  if (
    !directoryName ||
    directoryName === "." ||
    directoryName === ".." ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject path separators and control bytes before temporary writes.
    /[/\\:\x00-\x1f\x7f-\x9f]/.test(directoryName)
  ) {
    throw new Error("Invalid skill directory basename");
  }
  const temporary = mkdtempSync(join(tmpdir(), "pi-skills-metadata-"));
  try {
    const directory = join(temporary, directoryName);
    mkdirSync(directory, { mode: 0o700 });
    stage(directory);
    const declaredPath = join(directory, "SKILL.md");
    const result = loadSkillsFromDir({ dir: directory, source: "path" });
    // Ignore rules can hide SKILL.md while a different Markdown file loads. That
    // standalone file must not make a declared directory bundle installable.
    const skill = result.skills.find((candidate) => candidate.filePath === declaredPath);
    const warnings = result.diagnostics.map((diagnostic) => diagnostic.message);
    return {
      name: skill?.name ?? directoryName,
      description: skill?.description ?? "",
      warnings,
      ...(skill
        ? {}
        : { disabledReason: warnings.join("; ") || "Pi did not load this SKILL.md (check metadata and ignore rules)" }),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Validate data only. Pi's public loader reads Markdown; it never runs programs. */
export function inspectMetadata(content: string, directoryName: string): SkillMetadata {
  return inspectStaged(directoryName, (directory) => {
    writeFileSync(join(directory, "SKILL.md"), content, { mode: 0o600 });
  });
}

/** Validate a complete bundle, including Pi's native ignore-file behavior. */
export function inspectBundleMetadata(files: readonly BundleFile[], directoryName: string): SkillMetadata {
  const seen = new Set<string>();
  for (const file of files) {
    if (
      !file.path ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Untrusted bundle paths must not escape staging or use control bytes.
      /[\\:\x00-\x1f\x7f-\x9f]/.test(file.path) ||
      file.path
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.toLowerCase() === ".git" ||
            /[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ) ||
      seen.has(file.path.toLowerCase())
    ) {
      throw new Error("Unsafe or duplicate bundle file path");
    }
    seen.add(file.path.toLowerCase());
  }
  return inspectStaged(directoryName, (directory) => {
    for (const file of files) {
      const path = join(directory, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file.content, { mode: file.executable ? 0o700 : 0o600, flag: "wx" });
    }
  });
}
