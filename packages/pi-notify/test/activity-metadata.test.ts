import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { isUserActivity } from "../src/activity.js";
import { displayPath, notificationMetadata, safeText } from "../src/metadata.js";
import type { Notification } from "../src/provider.js";

function emphasis(notification: Notification) {
  return notification.bodyEmphasis?.map(({ style, offset, length }) => ({
    style,
    text: notification.body.slice(offset, offset + length),
  }));
}

it.each([
  ["", false],
  ["hello", true],
  ["中文😀", true],
  ["\r", true],
  ["\x03", true],
  ["\x1b", true],
  ["\x1b[A", true],
  ["\x1b[1;5A", true],
  ["\x1b[97;1u", true],
  ["\x1b[97;1:3u", false],
  ["\x1b[I", true],
  ["\x1b[O", false],
  ["\x1b[200~hello\nworld\x1b[201~", true],
  ["\x1b[<0;4;3M", true],
  ["\x1b[<0;4;3m", false],
  ["\x1b[<35;4;3M", false],
  ["\x1b[<32;4;3M", false],
  ["\x1b[<64;4;3M", true],
  ["\x1b[M !!", true],
  ["\x1b[M#!!", false],
  ["\x1b[MC!!", false],
  ["\x1b[?1;2c", false],
  ["\x1b[>1;2c", false],
  ["\x1b[?7u", false],
  ["\x1b[10;20R", false],
  ["\x1b[6;10;20t", false],
  ["\x1b]11;rgb:ffff/ffff/ffff\x07", false],
  ["\x1bP>|terminal\x1b\\", false],
  ["\x1b_Gi=1;OK\x1b\\", false],
])("classifies %j as activity=%s", (data, activity) => {
  expect(isUserActivity(String(data))).toBe(activity);
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
const data = {
  id: "period",
  cwd: "/missing-pi-notify-workspace",
  sessionId: "session",
  sessionName: "name",
  startedAt: 0,
  settledAt: 61000,
  error: false,
};
it("omits unavailable Git and strips terminal controls, bidi, and mentions", async () => {
  const notification = await notificationMetadata(
    { ...data, sessionName: "evil\x1b[31m\x1b]52;c;secret\x07\u202e@person" },
    new AbortController().signal,
  );
  expect(notification.title).toBe("Pi is ready for review");
  expect(notification.body).toContain("Elapsed: 61s");
  expect(notification.body).toContain("Stopped: 1970-01-01T00:01:01.000Z");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Assert terminal injection removal.
  expect(notification.body).not.toMatch(/Repository:|\x1b|\u202e|@person|secret/);
  expect(displayPath(join(homedir(), "src", "app"))).toBe("~/src/app");
  expect(safeText("\x1b[31mname")).toBe("name");
  expect(emphasis(notification)).toEqual([
    { style: "monospace", text: "session" },
    { style: "monospace", text: data.cwd },
  ]);
});
it.each([undefined, "", "😀中文e\u0301\x1b[31m@person"])(
  "formats only the sanitized ID in a session named %j",
  async (sessionName) => {
    const notification = await notificationMetadata(
      { ...data, sessionName, sessionId: "😀id\x1b[31m@session" },
      new AbortController().signal,
    );
    expect(notification.body).toContain(`Session: ${sessionName ? "😀中文e\u0301＠person " : ""}(😀id＠session)`);
    expect(emphasis(notification)).toEqual([
      { style: "monospace", text: "😀id＠session" },
      { style: "monospace", text: data.cwd },
    ]);
  },
);
it("identifies ordinary and linked Git worktrees and detached HEAD", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pi-notify-git-"));
  directories.push(directory);
  const repo = join(directory, "app");
  const linked = join(directory, "feature");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "test",
    ],
    { stdio: "ignore" },
  );
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", "feature", linked], { stdio: "ignore" });
  const ordinary = await notificationMetadata({ ...data, cwd: repo }, new AbortController().signal);
  expect(emphasis(ordinary)).toEqual([
    { style: "monospace", text: "session" },
    { style: "monospace", text: repo },
    { style: "bold", text: "app" },
    { style: "monospace", text: repo },
    { style: "monospace", text: "main" },
  ]);
  const notification = await notificationMetadata({ ...data, cwd: linked }, new AbortController().signal);
  expect(emphasis(notification)).toEqual([
    { style: "monospace", text: "session" },
    { style: "monospace", text: linked },
    { style: "bold", text: "app" },
    { style: "monospace", text: linked },
    { style: "monospace", text: "feature" },
  ]);
  expect(notification.body).toContain("Repository: app");
  expect(notification.body).toContain("Branch: feature");
  execFileSync("git", ["-C", linked, "checkout", "--detach"], { stdio: "ignore" });
  const detached = await notificationMetadata({ ...data, cwd: linked, error: true }, new AbortController().signal);
  expect(detached.body).toMatch(/Branch: detached [a-f0-9]+/);
  expect(detached.title).toBe("Pi stopped with an error");
  expect(emphasis(detached)?.at(-1)).toEqual({
    style: "monospace",
    text: expect.stringMatching(/^detached [a-f0-9]+$/),
  });
});
it("aborts metadata without leaking subprocess errors", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(notificationMetadata(data, controller.signal)).rejects.toThrow();
});
