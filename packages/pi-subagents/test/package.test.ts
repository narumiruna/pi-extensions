import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package declares one generated extension without a bundled skill", () => {
  const manifest = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as {
    name: string;
    description: string;
    private: boolean;
    files: string[];
    pi: { extensions: string[]; skills?: string[] };
    peerDependencies: Record<string, string>;
    repository: { directory: string };
  };
  assert.equal(manifest.name, "@narumitw/pi-subagents");
  assert.doesNotMatch(manifest.description, /\b(?:background|bounded)\b/i);
  assert.equal(manifest.private, false);
  assert.equal(manifest.repository.directory, "packages/pi-subagents");
  assert.deepEqual(manifest.pi.extensions, ["./dist/index.ts"]);
  assert.equal("skills" in manifest.pi, false);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-ai"], "*");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.ok(manifest.files.includes("src"));
  assert.ok(manifest.files.includes("dist"));
  assert.equal(manifest.files.includes("skills"), false);
  assert.equal(manifest.files.includes("examples"), false);
  assert.ok(manifest.files.includes("docs"));
});

test("repository example skill documents every minimal-runtime operating responsibility", () => {
  const skill = readFileSync(path.join(packageDirectory, "skills", "using-pi-subagents", "SKILL.md"), "utf8");
  assert.match(skill, /^name: using-pi-subagents$/m);
  assert.doesNotMatch(skill, /\b(?:background|bounded)\b/i);
  for (const evidence of [
    /prefer direct work/i,
    /subagent_spawn/i,
    /default of `read`, `grep`, `find`, and `ls`/i,
    /select only from `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`/i,
    /smallest sufficient tool set/i,
    /`bash` and `powershell` as unrestricted command execution/i,
    /Attach `skills`.*progressive disclosure/is,
    /Each attached skill path.*at least one skill Pi can load/is,
    /skill names unique across all attachments/is,
    /Every declared skill.*must load successfully/is,
    /Attaching a skill does not inject its complete body.*add `read` or `bash`/is,
    /Attach `extensions`.*trust.*executable code/is,
    /16 KiB.*startup bootstrap/is,
    /extension tool list.*not a sandbox/is,
    /never pass npm, Git, URL/is,
    /missing tool.*fails the job without a model request/is,
    /inherits the main agent's effective provider and model/i,
    /omit `thinkingLevel` to follow the main agent/i,
    /self-contained tasks/i,
    /shortest realistic execution deadline/i,
    /parallel tool batch/i,
    /subagent_wait/i,
    /wait timeout does not cancel/i,
    /subagent_inspect/i,
    /subagent_cancel/i,
    /subagent_send/i,
    /bidirectional|both directions/i,
    /not.*user request.*permission/is,
    /partial.*failed.*timed_out.*cancelled/is,
    /writer's statements.*claims rather than proof/is,
    /disjoint.*ownership/is,
    /workspace isolation/i,
  ]) {
    assert.match(skill, evidence);
  }
  for (const nonGoal of [
    "retained conversations",
    "user-directed follow-up turns",
    "mailboxes",
    "chains",
    "panels",
    "workflows",
    "nested subagents",
  ]) {
    assert.match(skill, new RegExp(nonGoal, "i"));
  }
});

test("published documentation separates tool usage from attachment behavior and safety", () => {
  const readme = readFileSync(path.join(packageDirectory, "README.md"), "utf8");
  const tools = readFileSync(path.join(packageDirectory, "docs", "tools.md"), "utf8");
  const attachments = readFileSync(path.join(packageDirectory, "docs", "attachments.md"), "utf8");
  const messaging = readFileSync(path.join(packageDirectory, "docs", "messaging.md"), "utf8");

  assert.match(readme, /\]\(\.\/docs\/tools\.md\)/u);
  assert.match(readme, /\]\(\.\/docs\/attachments\.md\)/u);
  assert.match(readme, /\]\(\.\/docs\/messaging\.md\)/u);
  assert.match(tools, /\]\(\.\/attachments\.md\)/u);
  assert.match(tools, /\]\(\.\/messaging\.md\)/u);
  assert.match(attachments, /\]\(\.\/tools\.md\)/u);
  assert.match(messaging, /\]\(\.\/tools\.md\)/u);
  for (const document of [readme, tools, attachments]) {
    assert.match(document, /`skills`/u);
    assert.match(document, /`extensions`/u);
    assert.doesNotMatch(document, /skillCount|extensionCount/u);
  }
  for (const document of [readme, tools]) {
    assert.match(document, /progressive disclosure/iu);
    assert.match(document, /at least one.*loadable.*skill/iu);
    assert.match(document, /skill names?.*unique/iu);
    assert.match(document, /every non-ignored declared skill.*must load successfully/iu);
    assert.match(document, /local path/iu);
    assert.match(document, /not (?:in a |an? )?(?:operating-system )?sandbox/iu);
    assert.match(document, /before.*(?:task|model)/iu);
  }
  assert.match(readme, /project.*trust/iu);
  assert.match(readme, /process-local runtime API key/iu);
  assert.match(attachments, /project is untrusted/iu);
  assert.match(attachments, /bootstrap.*16 KiB/iu);
  assert.match(attachments, /startup-hook errors/iu);
  assert.match(attachments, /process-local runtime API key/iu);
  assert.match(messaging, /first accepted response wins/iu);
  assert.match(messaging, /cross-job responses/iu);
  assert.match(messaging, /cancellation before RPC delivery/iu);
});
