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
import type { CodeBlockCopyButtonPosition, CodeBlockCopyMode } from "../src/settings.js";

vi.mock("node:fs/promises", { spy: true });

let base: string;
let agentDir: string;
let settingsFile: string;
let settings: typeof import("../src/settings.js");
const defaults = { enabled: true, text: INLINE_FORMATTING_PROMPT };
const defaultSnapshot = { prompt: defaults, codeBlockCopyMode: "button", codeBlockCopyButtonPosition: "left" };
const blockedSnapshot = { ...defaultSnapshot, codeBlockCopyMode: "off", saveBlocked: true };
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
  expect(settings.CODE_BLOCK_COPY_MODES).toEqual(["click", "button", "off"]);
  expect(settings.DEFAULT_CODE_BLOCK_COPY_MODE).toBe("button");
  expect(settings.CODE_BLOCK_COPY_BUTTON_POSITIONS).toEqual(["left", "right"]);
  expect(settings.DEFAULT_CODE_BLOCK_COPY_BUTTON_POSITION).toBe("left");
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual(defaultSnapshot);
  await expect(settings.savePromptHint(defaults, textChange(defaults.text), signal)).resolves.toBe(false);
  await expect(settings.saveCodeBlockCopyMode("button", "button", signal)).resolves.toBe(false);
  await expect(settings.saveCodeBlockCopyButtonPosition("left", "left", signal)).resolves.toBe(false);
  await expect(lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(open).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();

  await expect(settings.savePromptHint(defaults, disable, signal)).resolves.toBe(true);
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ promptHintEnabled: false });
  if (process.platform !== "win32") expect((await lstat(settingsFile)).mode & 0o777).toBe(0o600);
  expect(await readdir(agentDir)).toEqual(["pi-inline.json"]);
});

test.for([undefined, "click", "button", "off"] as const)(
  "loads the copy mode from a sparse file (%j)",
  async (mode) => {
    const source = await setDocument({ codeBlockCopyMode: mode });
    const codeBlockCopyMode = mode ?? "button";
    await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ ...defaultSnapshot, codeBlockCopyMode });
    await expect(settings.saveCodeBlockCopyMode(codeBlockCopyMode, codeBlockCopyMode, signal)).resolves.toBe(false);
    await expectIntact(source);
  },
);

test("persists either explicit position without materializing other defaults", async () => {
  await expect(settings.saveCodeBlockCopyButtonPosition("left", "right", signal)).resolves.toBe(true);
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ codeBlockCopyButtonPosition: "right" });
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual({
    ...defaultSnapshot,
    codeBlockCopyButtonPosition: "right",
  });
  await expect(settings.saveCodeBlockCopyButtonPosition("right", "left", signal)).resolves.toBe(true);
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ codeBlockCopyButtonPosition: "left" });
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual(defaultSnapshot);
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
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ ...defaultSnapshot, prompt: expected });
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
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual({
    ...defaultSnapshot,
    prompt: { enabled: false, text: "New" },
  });
});

test("edits the last copy mode key and preserves other JSON bytes", async () => {
  const unknown = '"future": [9007199254740993, -0, 1e400, {"codeBlockCopyMode":"unchanged"}]';
  const source = `{
  ${unknown},
  "promptHintText": "  Keep this  ",
  "codeBlockCopyMode": "shadowed",
  "codeBlock\\u0043opyMode": "button"
}\n`;
  await setSource(source);
  const prompt = { ...defaults, text: "  Keep this  " };
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ ...defaultSnapshot, prompt });
  await expect(settings.saveCodeBlockCopyMode("button", "off", signal)).resolves.toBe(true);
  const replaced = source.replace('"button"', '"off"');
  await expectIntact(replaced);
  await expect(settings.savePromptHint(prompt, textChange("New hint"), signal)).resolves.toBe(true);
  await expectIntact(replaced.replace('"  Keep this  "', '"New hint"'));
});

test.for(["{broken\x1b[31msecret", "null", "[]", '"string"'])("does not replace invalid JSON (%j)", async (source) => {
  await setSource(source);
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual(blockedSnapshot);
  await expect(settings.savePromptHint(defaults, disable, signal)).rejects.toThrow(
    "Settings cannot be saved. Repair the user pi-inline.json file and reopen the menu.",
  );
  await expect(settings.saveCodeBlockCopyMode("off", "button", signal)).rejects.toThrow(
    "Repair the user pi-inline.json",
  );
  await expectIntact(source);
});

test("disables copying and blocks saving when the existing file cannot be opened", async () => {
  const source = await setDocument({ codeBlockCopyMode: "button" });
  const denied = Object.assign(new Error("secret path"), { code: "EACCES" });
  vi.mocked(open).mockRejectedValueOnce(denied).mockRejectedValueOnce(denied);
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual(blockedSnapshot);
  await expect(settings.saveCodeBlockCopyMode("off", "click", signal)).rejects.toThrow("Repair the user");
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual(defaultSnapshot);
  await expectIntact(source);
});

test("does not repair invalid UTF-8 in unknown fields", async () => {
  const source = Buffer.concat([Buffer.from('{"unknown":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  await mkdir(agentDir);
  await writeFile(settingsFile, source);
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual(blockedSnapshot);
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
    codeBlockCopyMode: "button",
    ...overrides,
  });
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual(blockedSnapshot);
  await expect(settings.savePromptHint(defaults, disable, signal)).rejects.toThrow("Repair the user pi-inline.json");
  await expect(settings.saveCodeBlockCopyMode("off", "click", signal)).rejects.toThrow(
    "Repair the user pi-inline.json",
  );
  await expectIntact(source);
});

test.for([null, true, 0, {}, ["click"], "", "Click", "off "])(
  "keeps a valid prompt but disables copying and blocks all saves for an invalid mode (%j)",
  async (mode) => {
    const prompt = { enabled: false, text: "  Custom\n\t hint  " };
    const source = await setDocument({
      promptHintEnabled: prompt.enabled,
      promptHintText: prompt.text.replaceAll("\n", "\r\n"),
      codeBlockCopyMode: mode,
      codeBlockCopyButtonPosition: "right",
    });
    await expect(settings.loadPromptSettings(signal)).resolves.toEqual({
      ...blockedSnapshot,
      prompt,
      codeBlockCopyButtonPosition: "right",
    });
    await expect(settings.savePromptHint(prompt, textChange("New hint"), signal)).rejects.toThrow("Repair the user");
    await expect(settings.saveCodeBlockCopyMode("off", "off", signal)).rejects.toThrow("Repair the user");
    await expectIntact(source);
  },
);

test.for([null, true, 0, {}, ["left"], "", "Left", "right "])(
  "uses left but keeps a valid copy mode and prompt and blocks all saves for an invalid position (%j)",
  async (position) => {
    const prompt = { enabled: false, text: "  Custom\n\t hint  " };
    const source = await setDocument({
      promptHintEnabled: prompt.enabled,
      promptHintText: prompt.text.replaceAll("\n", "\r\n"),
      codeBlockCopyMode: "click",
      codeBlockCopyButtonPosition: position,
    });
    await expect(settings.loadPromptSettings(signal)).resolves.toEqual({
      ...blockedSnapshot,
      prompt,
      codeBlockCopyMode: "click",
    });
    await expect(settings.savePromptHint(prompt, textChange("New hint"), signal)).rejects.toThrow("Repair the user");
    await expect(settings.saveCodeBlockCopyMode("click", "button", signal)).rejects.toThrow("Repair the user");
    await expect(settings.saveCodeBlockCopyButtonPosition("left", "right", signal)).rejects.toThrow("Repair the user");
    await expectIntact(source);
  },
);

test.for([null, {}, [], ["/no-longer-checked"]])(
  "ignores and preserves the removed external preview setting (%j)",
  async (externalPreviewRoots) => {
    const source = `{"externalPreviewRoots": ${JSON.stringify(externalPreviewRoots)}, "promptHintText": "Keep this"}`;
    await setSource(source);
    const prompt = { enabled: true, text: "Keep this" };
    await expect(settings.loadPromptSettings(signal)).resolves.toEqual({ ...defaultSnapshot, prompt });
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
    await expect(settings.loadPromptSettings(signal)).resolves.toEqual(blockedSnapshot);
    await expect(settings.savePromptHint(defaults, disable, signal)).rejects.toThrow("Repair the user");
    await expect(settings.saveCodeBlockCopyMode("off", "button", signal)).rejects.toThrow("Repair the user");
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
    await expect(settings.loadPromptSettings(signal)).resolves.toEqual(blockedSnapshot);
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

test("rejects an invalid requested copy mode before accessing the file", async () => {
  const invalid = "secret\x1b[0m" as CodeBlockCopyMode;
  await expect(settings.saveCodeBlockCopyMode("click", invalid, signal)).rejects.toThrow(
    "Select Click block, Copy button, or Off for code block copy.",
  );
  expect(lstat).not.toHaveBeenCalled();
});

test("rejects an invalid requested copy button position before accessing the file", async () => {
  const invalid = "secret\x1b[0m" as CodeBlockCopyButtonPosition;
  await expect(settings.saveCodeBlockCopyButtonPosition("left", invalid, signal)).rejects.toThrow(
    "Select Left or Right for the code block copy button position.",
  );
  expect(lstat).not.toHaveBeenCalled();
});

test("orders rapid reads and field updates through a directory alias and rejects stale edits", async () => {
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
  const first = settings.saveCodeBlockCopyMode("button", "click", signal);
  await entered.promise;
  const afterFirst = settings.loadPromptSettings(signal);
  const text = settings.savePromptHint(defaults, textChange("Second change"), signal);
  const afterText = settings.loadPromptSettings(signal);
  const position = settings.saveCodeBlockCopyButtonPosition("left", "right", signal);
  const afterPosition = settings.loadPromptSettings(signal);
  const staleMode = expect(settings.saveCodeBlockCopyMode("button", "click", signal)).rejects.toThrow(
    "Settings changed. Reopen the menu before saving.",
  );
  const staleHint = expect(settings.savePromptHint(defaults, textChange("Second change"), signal)).rejects.toThrow(
    "Settings changed. Reopen the menu before saving.",
  );
  const stalePosition = expect(settings.saveCodeBlockCopyButtonPosition("left", "right", signal)).rejects.toThrow(
    "Settings changed. Reopen the menu before saving.",
  );
  const mode = settings.saveCodeBlockCopyMode("click", "off", signal);
  const afterMode = settings.loadPromptSettings(signal);
  resume.resolve();

  const firstSnapshot = { ...defaultSnapshot, codeBlockCopyMode: "click" };
  const textSnapshot = { ...firstSnapshot, prompt: { ...defaults, text: "Second change" } };
  const positionSnapshot = { ...textSnapshot, codeBlockCopyButtonPosition: "right" };
  await expect(first).resolves.toBe(true);
  await expect(afterFirst).resolves.toEqual(firstSnapshot);
  await expect(text).resolves.toBe(true);
  await expect(afterText).resolves.toEqual(textSnapshot);
  await expect(position).resolves.toBe(true);
  await expect(afterPosition).resolves.toEqual(positionSnapshot);
  await staleMode;
  await staleHint;
  await stalePosition;
  await expect(mode).resolves.toBe(true);
  await expect(afterMode).resolves.toEqual({ ...positionSnapshot, codeBlockCopyMode: "off" });
  expect(rename).toHaveBeenCalledTimes(4);
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
    promptHintText: "Second change",
    codeBlockCopyMode: "off",
    codeBlockCopyButtonPosition: "right",
  });
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
  await expect(settings.loadPromptSettings(signal)).resolves.toEqual(defaultSnapshot);
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
  await setDocument({ codeBlockCopyButtonPosition: "right" });
  const pending = settings.saveCodeBlockCopyMode("button", "click", controller.signal);
  await entered.promise;
  const queued = settings.saveCodeBlockCopyMode("click", "off", controller.signal);
  const queuedPosition = settings.saveCodeBlockCopyButtonPosition("right", "left", controller.signal);
  const cancelledRead = settings.loadPromptSettings(controller.signal);
  const read = settings.loadPromptSettings(signal);
  controller.abort();
  resume.resolve();
  await expect(pending).resolves.toBe(true);
  await expect(queued).resolves.toBe(false);
  await expect(queuedPosition).resolves.toBe(false);
  await expect(cancelledRead).resolves.toEqual({ ...defaultSnapshot, codeBlockCopyMode: "off" });
  await expect(read).resolves.toEqual({
    ...defaultSnapshot,
    codeBlockCopyMode: "click",
    codeBlockCopyButtonPosition: "right",
  });
  expect(rename).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
    codeBlockCopyMode: "click",
    codeBlockCopyButtonPosition: "right",
  });
});
