import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { INLINE_FORMATTING_PROMPT } from "../src/prompt.js";

vi.mock("node:fs/promises", { spy: true });

let base: string;
let agentDir: string;
let settingsFile: string;
let settings: typeof import("../src/settings.js");
const defaults = { enabled: true, text: INLINE_FORMATTING_PROMPT };
const signal = new AbortController().signal;
const disable = { key: "promptHintEnabled", value: false } as const;
const textChange = (value: string) => ({ key: "promptHintText", value }) as const;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "pi-inline-settings-")));
  agentDir = join(base, "agent");
  settingsFile = join(agentDir, "pi-inline.json");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("HOME", join(base, "home"));
  vi.resetModules();
  settings = await import("../src/settings.js");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await rm(base, { recursive: true, force: true });
});

async function setSource(text: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(settingsFile, text);
}

async function setDocument(value: unknown): Promise<string> {
  const source = JSON.stringify(value);
  await setSource(source);
  return source;
}

async function expectIntact(source: string): Promise<void> {
  expect(await readFile(settingsFile, "utf8")).toBe(source);
  expect(await readdir(agentDir)).toEqual(["pi-inline.json"]);
}

test("loads defaults and leaves a missing user settings directory untouched until a changed save", async () => {
  expect(settings.DEFAULT_PROMPT_HINT).toEqual(defaults);
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ prompt: defaults });
  await expect(settings.savePromptHint(defaults, textChange(defaults.text), signal)).resolves.toBe(false);
  await expect(lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(open).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();

  await expect(settings.savePromptHint(defaults, disable, signal)).resolves.toBe(true);
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ promptHintEnabled: false });
  if (process.platform !== "win32") expect((await lstat(settingsFile)).mode & 0o777).toBe(0o600);
  expect(await readdir(agentDir)).toEqual(["pi-inline.json"]);
});

test("normalizes CRLF and leaves significant whitespace and unknown fields intact", async () => {
  const rawText = "  First line\t\r\n\r\n\tLast line  \r\n";
  const expected = { enabled: false, text: rawText.replaceAll("\r\n", "\n") };
  const original = {
    ["__proto__"]: { future: true },
    unknown: [false, null, { enabled: true }],
    promptHintEnabled: false,
    promptHintText: rawText,
  };
  const source = await setDocument(original);
  vi.mocked(lstat).mockClear();
  vi.mocked(realpath).mockClear();
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ prompt: expected });
  expect(lstat).toHaveBeenCalledExactlyOnceWith(settingsFile, { bigint: true });
  expect(vi.mocked(realpath).mock.calls.every(([path]) => path === settingsFile)).toBe(true);
  await expect(settings.savePromptHint(expected, textChange(rawText), signal)).resolves.toBe(false);
  await expectIntact(source);
  await expect(settings.savePromptHint(expected, { key: "promptHintEnabled", value: true }, signal)).resolves.toBe(
    true,
  );
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ ...original, promptHintEnabled: true });
  await expect(settings.savePromptHint(expected, textChange("\tNew\r\n  hint "), signal)).resolves.toBe(true);
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
    ...original,
    promptHintEnabled: true,
    promptHintText: "\tNew\n  hint ",
  });
});

test("updates only prompt keys and preserves unrecognized JSON values byte for byte", async () => {
  const unknown = '"future": [9007199254740993, -0, 1e400, {"promptHintText":"unchanged","more":1.2300}]';
  const source = `{\n  ${unknown},\n  "promptHintText": "shadowed",\n  "promptHint\\u0054ext": "Current"\n}\n`;
  await setSource(source);
  await expect(settings.savePromptHint({ ...defaults, text: "Current" }, textChange("New"), signal)).resolves.toBe(
    true,
  );
  const replaced = source.replace('"Current"', '"New"');
  await expectIntact(replaced);
  await expect(settings.savePromptHint(defaults, disable, signal)).resolves.toBe(true);
  await expectIntact(replaced.replace('"New"\n', '"New",\n  "promptHintEnabled": false\n'));
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ prompt: { enabled: false, text: "New" } });
});

test.for(["{broken\x1b[31msecret", "null", "[]", '"string"'])("does not replace invalid JSON (%j)", async (source) => {
  await setSource(source);
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ prompt: defaults, saveBlocked: true });
  await expect(settings.savePromptHint(defaults, disable, signal)).rejects.toThrow(
    "Settings cannot be saved. Repair the user pi-inline.json file and reopen the menu.",
  );
  await expectIntact(source);
});

test("does not repair invalid UTF-8 in unknown fields", async () => {
  const source = Buffer.concat([Buffer.from('{"unknown":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  await mkdir(agentDir);
  await writeFile(settingsFile, source);
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ prompt: defaults, saveBlocked: true });
  await expect(settings.savePromptHint(defaults, disable, signal)).rejects.toThrow("Repair the user");
  expect(await readFile(settingsFile)).toEqual(source);
});

test.for([
  { promptHintEnabled: 1 },
  { promptHintEnabled: "false" },
  { promptHintText: null },
  { promptHintText: " \t\r\n" },
  { promptHintText: "Lone\rreturn" },
  { promptHintText: "Unexpected\x1b[0m" },
  { promptHintText: "Unexpected\u009b0m" },
  { promptHintText: "Unexpected\x7f" },
  { promptHintText: "Unexpected\u200e" },
  { promptHintText: "Unexpected\u202e" },
  { promptHintText: "Unexpected\u2066" },
])("uses the default hint and blocks saving for invalid prompt values (%j)", async (overrides) => {
  const source = await setDocument({
    promptHintEnabled: false,
    promptHintText: "Custom hint",
    ...overrides,
  });
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ prompt: defaults, saveBlocked: true });
  await expect(settings.savePromptHint(defaults, disable, signal)).rejects.toThrow("Repair the user pi-inline.json");
  await expectIntact(source);
});

test.for([null, {}, [], ["/no-longer-checked"]])(
  "ignores and preserves the removed external preview setting (%j)",
  async (externalPreviewRoots) => {
    const source = `{"externalPreviewRoots": ${JSON.stringify(externalPreviewRoots)}, "promptHintText": "Keep this"}`;
    await setSource(source);
    const prompt = { enabled: true, text: "Keep this" };
    await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ prompt });
    await expect(settings.savePromptHint(prompt, textChange("New text"), signal)).resolves.toBe(true);
    await expectIntact(source.replace("Keep this", "New text"));
  },
);

test.for(["directory", "symlink", ...(process.platform === "win32" ? [] : ["fifo"])])(
  "does not read or replace a settings %s",
  async (type) => {
    const target = join(base, "other.json");
    await mkdir(agentDir);
    await writeFile(target, '{"promptHintEnabled":false}');
    if (type === "symlink") await symlink(target, settingsFile, "file");
    else if (type === "fifo") execFileSync("mkfifo", [settingsFile]);
    else await mkdir(settingsFile);
    await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ prompt: defaults, saveBlocked: true });
    await expect(settings.savePromptHint(defaults, disable, signal)).rejects.toThrow("Repair the user");
    expect(open).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe('{"promptHintEnabled":false}');
    expect(await readdir(agentDir)).toEqual(["pi-inline.json"]);
  },
);

test("uses nofollow and closes the handle without reading a different regular file swapped during open", async () => {
  await setDocument({ promptHintText: "Original" });
  const replacement = join(agentDir, "replacement");
  await writeFile(replacement, '{"promptHintText":"Unrelated"}');
  const other = await open(replacement, "r");
  const close = vi.spyOn(other, "close");
  vi.mocked(open).mockClear();
  vi.mocked(open).mockImplementationOnce(async () => {
    await rename(replacement, settingsFile);
    return other;
  });
  try {
    await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ prompt: defaults, saveBlocked: true });
    expect(open).toHaveBeenCalledExactlyOnceWith(
      settingsFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await other.close();
  }
});

test("rejects invalid input without revealing the submitted text or creating a file", async () => {
  await expect(settings.savePromptHint(defaults, textChange("Secret\x1b[0m"), signal)).rejects.toThrow(
    "Enter a nonblank prompt hint without terminal or bidirectional controls.",
  );
  expect(open).not.toHaveBeenCalled();
  await expect(lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test("orders first saves and loads through a directory alias and rejects stale edits of the same key", async () => {
  const actualAgentDir = join(base, "agent-target");
  await mkdir(actualAgentDir);
  await symlink(actualAgentDir, agentDir, "dir");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    entered.resolve();
    await resume.promise;
    await actual.rename(from, to);
  });
  const first = settings.savePromptHint(defaults, disable, signal);
  await entered.promise;
  const text = settings.savePromptHint(defaults, textChange("Second change"), signal);
  const replaced = expect(settings.savePromptHint(defaults, disable, signal)).rejects.toThrow(
    "Settings changed. Reopen the menu before saving.",
  );
  const hint = settings.loadPromptSettings(signal);
  const expected = { enabled: false, text: "Second change" };
  resume.resolve();
  await expect(first).resolves.toBe(true);
  await expect(text).resolves.toBe(true);
  await replaced;
  await expect(hint).resolves.toEqual({ prompt: expected });
  expect(rename).toHaveBeenCalledTimes(2);
});

test.for(["write", "rename"])("retains the original bytes and cleans up after a failed %s", async (stage) => {
  const source = await setDocument({ unknown: { nested: true } });
  const error = new Error("secret path\x1b[0m");
  if (stage === "write") vi.mocked(writeFile).mockRejectedValueOnce(error);
  else vi.mocked(rename).mockRejectedValueOnce(error);
  await expect(settings.savePromptHint(defaults, disable, signal)).rejects.toThrow(
    "Settings were not saved. Check file permissions and available disk space.",
  );
  expect(rename).toHaveBeenCalledTimes(stage === "write" ? 0 : 1);
  await expectIntact(source);
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ prompt: defaults });
  await expect(settings.savePromptHint(defaults, disable, signal)).resolves.toBe(true);
});

test.for(["abort", "replace"])("removes the temporary file without publishing on %s during write", async (action) => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const controller = new AbortController();
  const source = await setDocument({ promptHintText: "Current value" });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    await actual.writeFile(...args);
    entered.resolve();
    await resume.promise;
  });
  const pending = settings.savePromptHint({ ...defaults, text: "Current value" }, disable, controller.signal);
  await entered.promise;
  const replacement = '{"promptHintText":"Manual change"}';
  try {
    if (action === "abort") controller.abort(new Error("secret reason"));
    else await actual.writeFile(settingsFile, replacement);
  } finally {
    resume.resolve();
  }
  if (action === "abort") await expect(pending).resolves.toBe(false);
  else await expect(pending).rejects.toThrow("Settings changed. Reopen the menu before saving.");
  expect(rename).not.toHaveBeenCalled();
  await expectIntact(action === "abort" ? source : replacement);
});

test("awaits a rename that has started before reporting the committed save, even after abort", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    entered.resolve();
    await resume.promise;
    await actual.rename(from, to);
  });
  const pending = settings.savePromptHint(defaults, disable, controller.signal);
  await entered.promise;
  const queued = settings.savePromptHint(defaults, textChange("Cancelled while queued"), controller.signal);
  const read = settings.loadPromptSettings(signal);
  controller.abort();
  resume.resolve();
  await expect(pending).resolves.toBe(true);
  await expect(queued).resolves.toBe(false);
  await expect(read).resolves.toEqual({ prompt: { ...defaults, enabled: false } });
  expect(rename).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ promptHintEnabled: false });
});
