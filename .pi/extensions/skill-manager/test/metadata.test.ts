import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { inspectBundleMetadata, inspectMetadata } from "../metadata.ts";

const created = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    mkdtempSync: (prefix: string) => {
      const path = fs.mkdtempSync(prefix);
      created.push(path);
      return path;
    },
  };
});
const document = (fields: string) => `---\n${fields}\n---\nInstructions only.\n`;

const bundleFile = (path: string, content: string, executable = false) => ({
  path,
  content: new TextEncoder().encode(content),
  executable,
});

describe("complete bundle validation", () => {
  it.each([".gitignore", ".ignore", ".fdignore"])(
    "honors native %s rules without accepting standalone fallback files",
    (ignore) => {
      const files = [
        bundleFile("SKILL.md", document("description: Declared.")),
        bundleFile(ignore, "SKILL.md\n"),
        bundleFile("README.md", document("description: Not the declared skill.")),
      ];
      expect(inspectBundleMetadata(files, "candidate").disabledReason).toContain("Pi did not load");
    },
  );

  it("keeps warnings, mismatch, and original bytes while reading a complete bundle", () => {
    const bytes = document("name: Bad--name\ndescription: Fine.");
    const files = [
      bundleFile("SKILL.md", bytes),
      bundleFile(".ignore", "support/*\n"),
      bundleFile("support/program.sh", "exit 99\n", true),
    ];
    expect(inspectBundleMetadata(files, "original")).toEqual(inspectMetadata(bytes, "original"));
    expect(new TextDecoder().decode(files[0].content)).toBe(bytes);
  });

  it("requires the declared file instead of any successfully loaded Markdown", () => {
    expect(
      inspectBundleMetadata([bundleFile("README.md", document("description: Standalone."))], "candidate")
        .disabledReason,
    ).toContain("Pi did not load");
  });

  it.each([
    "../escape",
    "/absolute",
    "a/../../escape",
    "a\\b",
    "a:b",
    "a//b",
    "a/./b",
    ".git/config",
    "line\nname",
    "NUL",
    "trailing.",
  ])("rejects unsafe bundle paths before staging: %s", (path) => {
    const before = created.length;
    expect(() => inspectBundleMetadata([bundleFile(path, "data")], "candidate")).toThrow("Unsafe");
    expect(created).toHaveLength(before);
  });

  it("rejects duplicate paths, including filesystem case collisions", () => {
    expect(() => inspectBundleMetadata([bundleFile("support", "a"), bundleFile("SUPPORT", "b")], "candidate")).toThrow(
      "duplicate",
    );
  });

  it("removes owned staging after ignore-rule rejection and partial-stage failures", () => {
    const before = created.length;
    inspectBundleMetadata(
      [bundleFile("SKILL.md", document("description: Fine.")), bundleFile(".ignore", "SKILL.md")],
      "candidate",
    );
    expect(() =>
      inspectBundleMetadata([bundleFile("support", "file"), bundleFile("support/child", "conflict")], "candidate"),
    ).toThrow();
    expect(created.length - before).toBe(2);
    expect(created.slice(before).every((path) => !existsSync(path))).toBe(true);
  });
});

describe("public Pi metadata validation", () => {
  it("keeps name/directory mismatches and native warning-only fields installable", () => {
    const metadata = inspectMetadata(
      document(
        `name: Not--portable-\ndescription: ${"d".repeat(1025)}\nlicense: 42\ncompatibility: []\nmetadata: false\nallowed-tools: anything\ndisable-model-invocation: true\nunknown: true`,
      ),
      "original-basename",
    );
    expect(metadata.name).toBe("Not--portable-");
    expect(metadata.description).toHaveLength(1025);
    expect(metadata.disabledReason).toBeUndefined();
    expect(metadata.warnings).toEqual([
      "description exceeds 1024 characters (1025)",
      "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
      "name must not start or end with a hyphen",
      "name must not contain consecutive hyphens",
    ]);
  });

  it("does not add a name mismatch warning or normalize metadata", () => {
    expect(inspectMetadata(document("name: declared-name\ndescription: '  Description.  '"), "directory-name")).toEqual(
      { name: "declared-name", description: "  Description.  ", warnings: [] },
    );
  });

  it.each(["", "name: ''", "name: false", "name: 42", "name: []", "name: null"])(
    "uses Pi's directory-name fallback for %s",
    (name) => {
      expect(inspectMetadata(document(`${name}\ndescription: Valid.`), "fallback")).toEqual({
        name: "fallback",
        description: "Valid.",
        warnings: [],
      });
    },
  );

  it.each([
    "",
    "description: ''",
    "description: '   '",
    "description: false",
    "description: 42",
    "description: []",
    "description: null",
  ])("disables missing or non-string descriptions: %s", (description) => {
    const metadata = inspectMetadata(document(`name: declared\n${description}`), "fallback");
    expect(metadata.disabledReason).toContain("description is required");
    expect(metadata.warnings).toContain("description is required");
    expect(metadata.description).toBe("");
  });

  it.each([
    "Instructions without frontmatter.",
    "---\ndescription: No closing delimiter",
    document("description: [broken"),
    document("description: first\ndescription: second"),
    document("- scalar"),
    document("null"),
    document("a scalar"),
  ])("shows malformed or undeclared metadata as disabled: %s", (content) => {
    expect(inspectMetadata(content, "candidate").disabledReason).toBeTruthy();
  });

  it("uses native BOM and newline handling without changing the original input", () => {
    const content = "\ufeff---\r\nname: good\r\ndescription: Fine.\r\n---\r\nBody\r\n";
    expect(inspectMetadata(content, "different")).toEqual({ name: "good", description: "Fine.", warnings: [] });
    expect(content.startsWith("\ufeff")).toBe(true);
  });

  it("retains overlong and invalid fallback-name warnings without disabling the skill", () => {
    const metadata = inspectMetadata(document("description: Fine."), `A${"x".repeat(64)}`);
    expect(metadata.disabledReason).toBeUndefined();
    expect(metadata.warnings).toEqual([
      "name exceeds 64 characters (65)",
      "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
    ]);
  });

  it("removes private staging on success, invalid metadata, and write failure", () => {
    const before = created.length;
    inspectMetadata(document("description: Fine."), "good");
    inspectMetadata(document("description: ["), "bad");
    expect(() => inspectMetadata(null as unknown as string, "write-error")).toThrow();
    expect(created.length - before).toBe(3);
    expect(created.slice(before).every((path) => !existsSync(path))).toBe(true);
  });

  it.each(["", ".", "..", "../escape", "/absolute", "a/b", "a\\b", "nul\0name", "line\nname"])(
    "rejects unsafe temporary directory names without creating data: %s",
    (directory) => {
      const before = created.length;
      expect(() => inspectMetadata(document("description: Fine."), directory)).toThrow("basename");
      expect(created).toHaveLength(before);
    },
  );
});
