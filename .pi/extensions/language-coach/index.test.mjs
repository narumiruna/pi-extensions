import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.argv[2]) throw new Error("Usage: node index.test.mjs /path/to/pi-coding-agent");
const packageRoot = resolve(process.argv[2]);
const sandbox = mkdtempSync(join(tmpdir(), "pi-language-coach-"));
process.env.PI_CODING_AGENT_DIR = sandbox;
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);
const requirePi = createRequire(join(packageRoot, "package.json"));
const { visibleWidth } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
// Pi AI has import-only exports, so CommonJS require.resolve cannot resolve its root.
const aiRoot = dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(packageRoot, "package.json"))));
const { validateToolArguments } = await import(pathToFileURL(join(aiRoot, "dist/index.js")).href);
const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

function resourceLoader(agentDir = sandbox, explicit = true, projectTrusted = true) {
  const settingsManager = sdk.SettingsManager.inMemory({});
  settingsManager.setProjectTrusted(projectTrusted);
  return new sdk.DefaultResourceLoader({
    cwd: sandbox,
    agentDir,
    settingsManager,
    noExtensions: explicit,
    additionalExtensionPaths: explicit ? [entrypoint] : [],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
}

const loader = resourceLoader();
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
const tool = extension.tools.get("teach_language")?.definition;
assert.ok(tool);

after(() => {
  loaded.runtime.invalidate("Test cleanup");
  rmSync(sandbox, { recursive: true, force: true });
});

const corrected = {
  sentence: "He go to work every day.",
  correction: "He goes to work every day.",
  explanation: "For a daily habit with he, use goes instead of go.",
};
const grammatical = {
  sentence: "Fix the bug.",
  correction: "Please fix the bug.",
  explanation:
    "The original is a correct command. Adding please makes the request more polite; it does not fix a grammar error.",
};

const spoken = {
  sentence: "I am in agreement with you.",
  correction: "I agree with you.",
  explanation: "The original is correct. I agree with you is shorter and more natural in everyday speech.",
};
const written = {
  sentence: "Please make an update to the API documentation.",
  correction: "Please update the API documentation.",
  explanation: "The original is correct. Use update as a verb to make the request shorter.",
};
const multilingual = [
  [
    "Traditional Chinese",
    {
      sentence: "我昨天有去參加了一個會議。",
      correction: "我昨天參加了一個會議。",
      explanation: "原句可以理解。省去「有去」後，句子更精簡。",
    },
  ],
  [
    "Japanese",
    {
      sentence: "昨日、友達と映画を見に行きます。",
      correction: "昨日、友達と映画を見に行きました。",
      explanation: "「昨日」は過去のことなので、「行きます」を「行きました」にします。",
    },
  ],
  [
    "Spanish",
    {
      sentence: "Yo tiene dos gatos.",
      correction: "Yo tengo dos gatos.",
      explanation: "Con yo, usa tengo en lugar de tiene.",
    },
  ],
  [
    "Arabic",
    {
      sentence: "أنا يذهب إلى العمل كل يوم.",
      correction: "أنا أذهب إلى العمل كل يوم.",
      explanation: "مع «أنا» نستخدم «أذهب» بدلًا من «يذهب».",
    },
  ],
  [
    "mixed Chinese and English",
    {
      sentence: "請幫我對這個 API 進行一個更新。",
      correction: "請幫我更新這個 API。",
      explanation: "原句沒有文法錯誤。把「進行一個更新」改成「更新」，表達更直接，API 名稱保持不變。",
    },
  ],
];
const lessons = [corrected, grammatical, spoken, written, ...multilingual.map(([, lesson]) => lesson)];

function uiHarness() {
  const widgets = new Map();
  const writes = [];
  const notifications = [];
  const roles = [];
  let color = "";
  const theme = {
    fg(role, text) {
      roles.push(role);
      return color ? `${color}${text}\u001b[0m` : text;
    },
    bold: (text) => text,
  };
  return {
    widgets,
    writes,
    notifications,
    roles,
    theme,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setWidget(key, content, options) {
        writes.push({ key, content, options });
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
      },
    },
    setColor(value) {
      color = value;
    },
    component() {
      const factory = widgets.get("english-grammar");
      assert.equal(typeof factory, "function");
      return factory({}, theme);
    },
    text(width = 80) {
      return this.component().render(width).join("\n");
    },
  };
}

function harness(mode = "tui", manager = sdk.SessionManager.inMemory(sandbox)) {
  const ui = uiHarness();
  const errors = [];
  const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, sandbox, manager, {});
  let pendingMessages = false;
  runner.bindCore(
    { appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
    { hasPendingMessages: () => pendingMessages },
  );
  runner.setUIContext(ui.ui, mode);
  runner.onError((error) => errors.push(error));
  return {
    ...ui,
    manager,
    runner,
    errors,
    setPendingMessages(value) {
      pendingMessages = value;
    },
    command() {
      const command = runner.getCommand("lesson");
      assert.ok(command, "/lesson must be registered");
      return command.handler("", runner.createCommandContext());
    },
    execute(params, signal, toolCallId = "lesson-test") {
      return tool.execute(toolCallId, params, signal, undefined, runner.createContext());
    },
  };
}

function appendLesson(manager, lesson, options = {}) {
  return manager.appendMessage({
    role: "toolResult",
    toolCallId: "lesson-test",
    toolName: "teach_language",
    content: [{ type: "text", text: "Lesson" }],
    details: { lesson },
    isError: false,
    timestamp: Date.now(),
    ...options,
  });
}

function appendUser(manager, content) {
  return manager.appendMessage({ role: "user", content, timestamp: Date.now() });
}

function appendCall(manager, lesson, toolCallId = "lesson-test") {
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "teach_language", arguments: lesson }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
}

function saveResult(manager, result, toolCallId = "lesson-test") {
  return appendLesson(manager, result.details.lesson, { details: result.details, toolCallId });
}

test("Jiti loads one model-only tool and /lesson without prompt or tool-activation hooks", () => {
  assert.deepEqual([...extension.tools.keys()], ["teach_language"]);
  assert.deepEqual([...extension.commands.keys()], ["lesson"]);
  assert.equal(tool.exposure, "model-only");
  assert.deepEqual([...extension.handlers.keys()].sort(), [
    "input",
    "session_shutdown",
    "session_start",
    "session_tree",
  ]);
  assert.match(tool.description, /not required on every turn/);
  assert.match(tool.description, /pasted or quoted/);
  assert.match(tool.description, /Always provide a revised sentence/);
  assert.match(tool.description, /original is already correct/);
  assert.equal(tool.promptSnippet, undefined);
  assert.equal(tool.promptGuidelines, undefined);
  assert.equal(tool.parameters.properties.sentence.maxLength, 300);
  assert.equal(tool.parameters.properties.correction.maxLength, 300);
  assert.ok(tool.parameters.required.includes("correction"));
  assert.equal(tool.parameters.properties.explanation.maxLength, 240);
  assert.equal(harness().writes.length, 0);
});

test("tool guidance proactively requests wording suggestions even when grammar is correct", () => {
  assert.match(tool.description, /^Proactively suggest/);
  assert.match(tool.description, /grammar or wording/);
  assert.match(tool.description, /Call this tool for improvements in clarity, naturalness, or concision/);
  assert.match(tool.description, /Do not wait for a grammar error or an explicit request for language help/);
  assert.match(tool.description, /spoken or written language/);
  assert.match(tool.description, /even when the grammar is correct/);
  assert.match(tool.description, /no useful improvement/);
  assert.match(tool.description, /original is already correct, say so/);
  assert.match(tool.description, /Do not treat valid imperatives or style preferences as errors/);
  assert.match(tool.parameters.properties.correction.description, /spoken or written language/);
  assert.match(tool.parameters.properties.explanation.description, /grammar or wording/);
});

test("guidance prioritizes meaningful changes and skips unrequested cosmetic politeness", () => {
  assert.match(tool.description, /Prioritize grammar errors and substantial wording improvements/);
  assert.match(tool.description, /Skip cosmetic changes, such as adding please, unless the user asks about tone/);
  assert.match(tool.description, /not required on every turn/);
  assert.match(tool.description, /Do not treat valid imperatives or style preferences as errors/);
});

test("tool guidance supports any language and prioritizes the current message's main language", () => {
  assert.match(tool.description, /in any language/);
  assert.match(tool.description, /user wrote in their current message/);
  assert.match(
    tool.description,
    /Focus on the main language of the user's current message, including mixed-language messages/,
  );
  assert.match(
    tool.description,
    /Keep the revision in the sentence's original language and writing system; do not translate it/,
  );
  assert.match(tool.parameters.properties.sentence.description, /user's own current message, in any language/);
  assert.match(tool.parameters.properties.correction.description, /same language and writing system/);
  assert.doesNotMatch(JSON.stringify({ description: tool.description, parameters: tool.parameters }), /\bEnglish\b/);
});

test("tool guidance requests short, simple explanations in the current message's main language", () => {
  assert.match(
    tool.description,
    /simple explanation in the main language of the user's current message, in one or two short sentences/,
  );
  assert.match(tool.description, /Use familiar words and explain any grammar terms/);
  assert.match(tool.parameters.properties.explanation.description, /main language of the user's current message/);
  assert.match(tool.parameters.properties.explanation.description, /simple words and one or two short sentences/);
});

test("English labels and lesson text appear in the widget and tool results", async () => {
  const h = harness();
  const result = await h.execute(corrected);
  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, h.theme, {});
  for (const text of [h.text(200), result.content[0].text, expanded.render(200).join("\n")]) {
    assert.ok(text.includes(`Original: ${corrected.sentence}`));
    assert.ok(text.includes(`Suggestion: ${corrected.correction}`));
    assert.ok(text.includes(`Explanation: ${corrected.explanation}`));
    assert.doesNotMatch(text, /\p{Script=Han}/u);
  }
  const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, h.theme, {});
  assert.equal(collapsed.render(80).join("\n").trimEnd(), "Language lesson updated.");
});

for (const [language, lesson] of multilingual) {
  test(`${language} lessons render and restore without translation`, async () => {
    const h = harness();
    const call = { type: "toolCall", id: "multilingual-test", name: tool.name, arguments: lesson };
    const result = await h.execute(validateToolArguments(tool, call));
    assert.deepEqual(result.details.lesson, lesson);
    const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, h.theme, {});
    const displayed = h.text(300);
    for (const text of [displayed, result.content[0].text, expanded.render(300).join("\n")]) {
      assert.ok(text.includes(`Original: ${lesson.sentence}`));
      assert.ok(text.includes(`Suggestion: ${lesson.correction}`));
      assert.ok(text.includes(`Explanation: ${lesson.explanation}`));
    }
    appendLesson(h.manager, lesson);
    for (const event of [
      { type: "session_start", reason: "startup" },
      { type: "session_start", reason: "reload" },
      { type: "session_tree", newLeafId: h.manager.getLeafId(), oldLeafId: null },
    ]) {
      await h.runner.emit(event);
      assert.equal(h.text(300), displayed);
    }
    assert.deepEqual(h.manager.getBranch().at(-1).message.details.lesson, lesson);
    assert.deepEqual(h.errors, []);
  });
}

test("Pi argument validation requires a revised sentence for new calls", () => {
  const call = (args) => ({ type: "toolCall", id: "validation-test", name: tool.name, arguments: args });
  for (const lesson of lessons) {
    assert.deepEqual(validateToolArguments(tool, call(lesson)), lesson);
  }
  assert.throws(
    () => validateToolArguments(tool, call({ sentence: grammatical.sentence, explanation: grammatical.explanation })),
    /correction/,
  );
});

test("a correction updates the above-editor widget and returns the full lesson", async () => {
  const h = harness();
  const result = await h.execute(corrected);
  assert.deepEqual(result.details.lesson, corrected);
  assert.match(result.content[0].text, /He goes to work every day\./);
  assert.match(result.content[0].text, /use goes instead of go/);
  assert.deepEqual(h.writes.at(-1).options, { placement: "aboveEditor" });
  const lines = h.component().render(80);
  assert.equal(lines[0], "─".repeat(80));
  assert.equal(h.roles[0], "borderMuted");
  assert.match(lines.join("\n"), /Language lesson/);
  assert.match(lines.join("\n"), /Suggestion: He goes/);
  assert.ok(lines.length <= 6);
});

for (const source of ["interactive", "rpc"]) {
  test(`${source} submissions hide the widget when idle or queued without changing lesson history`, async () => {
    for (const streamingBehavior of [undefined, "steer", "followUp"]) {
      const h = harness();
      await h.execute(corrected);
      appendLesson(h.manager, corrected);
      const messages = structuredClone(h.manager.getBranch().filter((entry) => entry.type === "message"));
      h.widgets.set("unrelated", ["Keep this widget"]);
      const images = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
      const result = await h.runner.emitInput("Next message", images, source, streamingBehavior);
      assert.deepEqual(result, { action: "continue" });
      assert.equal(h.widgets.has("english-grammar"), false);
      assert.deepEqual(h.widgets.get("unrelated"), ["Keep this widget"]);
      assert.deepEqual(
        h.manager.getBranch().filter((entry) => entry.type === "message"),
        messages,
      );

      await assert.rejects(h.execute({ ...corrected, correction: "" }));
      assert.equal(h.widgets.has("english-grammar"), false);
      appendUser(h.manager, "Next message");
      appendCall(h.manager, grammatical);
      await h.execute(grammatical);
      assert.match(h.text(), /Suggestion: Please fix the bug\./);
      assert.deepEqual(h.errors, []);
    }
  });
}

test("extension-injected input does not hide the current lesson", async () => {
  const h = harness();
  await h.execute(corrected);
  const widget = h.widgets.get("english-grammar");
  const writes = h.writes.length;
  assert.deepEqual(await h.runner.emitInput("Continue", undefined, "extension"), { action: "continue" });
  assert.equal(h.widgets.get("english-grammar"), widget);
  assert.equal(h.writes.length, writes);
  assert.deepEqual(h.errors, []);
});

test("submitting without a lesson is safe and does not affect other widgets", async () => {
  const h = harness();
  h.widgets.set("unrelated", ["Keep this widget"]);
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(await h.runner.emitInput("Next message", undefined, "interactive"), { action: "continue" });
  }
  assert.equal(h.widgets.has("english-grammar"), false);
  assert.deepEqual(h.widgets.get("unrelated"), ["Keep this widget"]);
  assert.deepEqual(h.errors, []);
});

test("dismissal survives startup, reload, and tree navigation without rewriting stored lessons", async () => {
  const h = harness();
  const lessonId = appendLesson(h.manager, corrected);
  const stored = structuredClone(h.manager.getBranch()[0]);
  await h.runner.emit({ type: "session_start", reason: "startup" });
  assert.match(h.text(), /He goes/);
  await h.runner.emitInput("Next message", undefined, "interactive");
  const dismissedId = h.manager.getLeafId();
  assert.notEqual(dismissedId, lessonId);
  for (const reason of ["startup", "reload"]) {
    await h.runner.emit({ type: "session_start", reason });
    assert.equal(h.widgets.has("english-grammar"), false);
  }
  h.manager.branch(lessonId);
  await h.runner.emit({ type: "session_tree", newLeafId: lessonId, oldLeafId: dismissedId });
  assert.match(h.text(), /He goes/);
  h.manager.branch(dismissedId);
  await h.runner.emit({ type: "session_tree", newLeafId: dismissedId, oldLeafId: lessonId });
  assert.equal(h.widgets.has("english-grammar"), false);
  assert.deepEqual(h.manager.getBranch()[0], stored);
  assert.deepEqual(h.errors, []);
});

test("/lesson reopens the latest successful branch lesson and preserves that choice across reload", async () => {
  const h = harness();
  appendLesson(h.manager, corrected);
  const selected = appendLesson(h.manager, written);
  appendLesson(h.manager, grammatical, { isError: true });
  appendLesson(h.manager, { sentence: "Invalid" });
  appendLesson(h.manager, grammatical, { toolName: "another_tool" });
  await h.runner.emitInput("Next message", undefined, "interactive");
  const dismissedId = h.manager.getLeafId();
  await h.command();
  assert.match(h.text(), /Suggestion: Please update the API documentation/);
  const shownId = h.manager.getLeafId();
  assert.notEqual(shownId, dismissedId);
  assert.equal(h.manager.getBranch().at(-1).data.lessonId, selected);
  await h.runner.emit({ type: "session_start", reason: "reload" });
  assert.match(h.text(), /Suggestion: Please update the API documentation/);
  h.manager.branch(dismissedId);
  await h.runner.emit({ type: "session_tree", newLeafId: dismissedId, oldLeafId: shownId });
  assert.equal(h.widgets.has("english-grammar"), false);
  await h.runner.emitInput("Another message", undefined, "interactive");
  await h.runner.emit({ type: "session_start", reason: "reload" });
  assert.equal(h.widgets.has("english-grammar"), false);
  assert.deepEqual(h.errors, []);
});

test("/lesson handles an empty branch and reopens legacy lessons without a revision", async () => {
  const h = harness();
  h.widgets.set("unrelated", ["Keep this widget"]);
  await h.command();
  assert.equal(h.widgets.has("english-grammar"), false);
  assert.deepEqual(h.widgets.get("unrelated"), ["Keep this widget"]);
  assert.deepEqual(h.notifications, [{ message: "No language lesson on this branch.", type: "info" }]);
  const legacy = { sentence: corrected.sentence, explanation: "Use goes with he." };
  appendLesson(h.manager, legacy, { toolName: "teach_english" });
  await h.runner.emitInput("Next message", undefined, "interactive");
  await h.command();
  assert.match(h.text(), /Use goes with he/);
  assert.doesNotMatch(h.text(), /Suggestion:/);
  assert.deepEqual(h.errors, []);
});

for (const streamingBehavior of ["steer", "followUp"]) {
  test(`${streamingBehavior} keeps late results hidden until a newer user message is processed`, async () => {
    const h = harness();
    appendUser(h.manager, corrected.sentence);
    await h.runner.emitInput(written.sentence, undefined, "interactive", streamingBehavior);
    h.setPendingMessages(true);
    // The old response can finish streaming after the new submission marker.
    appendCall(h.manager, corrected, "old-call");
    const stale = await h.execute(corrected, undefined, "old-call");
    assert.deepEqual(stale.details.lesson, corrected);
    assert.equal(stale.details.visibility.automatic, false);
    assert.equal(h.widgets.has("english-grammar"), false);
    saveResult(h.manager, stale, "old-call");
    await h.runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(h.widgets.has("english-grammar"), false);

    h.setPendingMessages(false);
    appendUser(h.manager, written.sentence);
    appendCall(h.manager, written, "new-call");
    const current = await h.execute(written, undefined, "new-call");
    saveResult(h.manager, current, "new-call");
    assert.equal(current.details.visibility.automatic, true);
    assert.match(h.text(), /Please update the API documentation/);
    await h.runner.emit({ type: "session_start", reason: "reload" });
    assert.match(h.text(), /Please update the API documentation/);
    assert.deepEqual(h.errors, []);
  });
}

test("old continuation results stay hidden before enqueue and after the queue is cleared", async () => {
  const h = harness();
  appendUser(h.manager, corrected.sentence);
  appendLesson(h.manager, corrected);
  await h.runner.emitInput(written.sentence, undefined, "interactive", "followUp");
  // An async input handler or a withdrawn queue can leave no pending messages.
  h.setPendingMessages(false);
  appendCall(h.manager, corrected);
  const result = await h.execute(corrected);
  saveResult(h.manager, result);
  assert.equal(h.widgets.has("english-grammar"), false);
  await h.runner.emit({ type: "session_start", reason: "reload" });
  assert.equal(h.widgets.has("english-grammar"), false);
  await h.command();
  assert.match(h.text(), /He goes/);
  const widget = h.widgets.get("english-grammar");
  const next = await h.execute(corrected);
  assert.equal(next.details.visibility.automatic, false);
  assert.equal(h.widgets.get("english-grammar"), widget);
  assert.deepEqual(h.errors, []);
});

test("automatic lessons stay hidden while any submitted user message remains queued", async () => {
  const h = harness();
  await h.runner.emitInput(corrected.sentence, undefined, "interactive", "steer");
  await h.runner.emitInput(written.sentence, undefined, "interactive", "followUp");
  appendUser(h.manager, corrected.sentence);
  appendCall(h.manager, corrected);
  h.setPendingMessages(true);
  const first = await h.execute(corrected);
  saveResult(h.manager, first);
  assert.equal(first.details.visibility.automatic, false);
  assert.equal(h.widgets.has("english-grammar"), false);
  h.setPendingMessages(false);
  appendUser(h.manager, written.sentence);
  appendCall(h.manager, written);
  const last = await h.execute(written);
  assert.equal(last.details.visibility.automatic, true);
  assert.match(h.text(), /Please update the API documentation/);
  assert.deepEqual(h.errors, []);
});

test("a result persisted after a later submission cannot undo that dismissal on reload", async () => {
  const h = harness();
  await h.runner.emitInput(corrected.sentence, undefined, "interactive");
  appendUser(h.manager, corrected.sentence);
  appendCall(h.manager, corrected);
  const result = await h.execute(corrected);
  assert.equal(result.details.visibility.automatic, true);
  await h.runner.emitInput(written.sentence, undefined, "interactive");
  saveResult(h.manager, result);
  await h.runner.emit({ type: "session_start", reason: "reload" });
  assert.equal(h.widgets.has("english-grammar"), false);
  await h.command();
  assert.match(h.text(), /He goes/);
  assert.deepEqual(h.errors, []);
});

test("an older starting run cannot reopen the widget while a newer input is still being prepared", async () => {
  const h = harness();
  await h.runner.emitInput(corrected.sentence, undefined, "interactive");
  // The next submission can arrive before the starting run stores its user message.
  await h.runner.emitInput(written.sentence, undefined, "interactive", "steer");
  appendUser(h.manager, corrected.sentence);
  appendCall(h.manager, corrected);
  h.setPendingMessages(false);
  const result = await h.execute(corrected);
  saveResult(h.manager, result);
  assert.equal(result.details.visibility.automatic, false);
  assert.equal(h.widgets.has("english-grammar"), false);
  await h.runner.emit({ type: "session_start", reason: "reload" });
  assert.equal(h.widgets.has("english-grammar"), false);
  assert.deepEqual(h.errors, []);
});

test("transformed prompts are saved without automatic display when input correlation is uncertain", async () => {
  const h = harness();
  await h.runner.emitInput("/template", undefined, "interactive");
  appendUser(h.manager, written.sentence);
  appendCall(h.manager, written);
  const result = await h.execute(written);
  saveResult(h.manager, result);
  assert.equal(result.details.visibility.automatic, false);
  assert.equal(h.widgets.has("english-grammar"), false);
  await h.command();
  assert.match(h.text(), /Please update the API documentation/);
  assert.deepEqual(h.errors, []);
});

test("malformed visibility entries cannot reveal a lesson from outside this branch or break restoration", async () => {
  const h = harness();
  for (const data of [
    undefined,
    null,
    false,
    42,
    "Invalid",
    {},
    { action: "show" },
    { action: "show", lessonId: "missing" },
  ]) {
    h.manager.appendCustomEntry("language-coach-visibility", data);
  }
  await h.runner.emit({ type: "session_start", reason: "reload" });
  assert.equal(h.widgets.has("english-grammar"), false);
  assert.deepEqual(h.errors, []);
  appendLesson(h.manager, corrected);
  await h.runner.emitInput(written.sentence, undefined, "interactive");
  h.manager.appendCustomEntry("language-coach-visibility", { action: "show", lessonId: "missing" });
  await h.runner.emit({ type: "session_start", reason: "reload" });
  assert.equal(h.widgets.has("english-grammar"), false);
  assert.deepEqual(h.errors, []);
});

test("a saved stale result does not claim the widget was updated", async () => {
  const h = harness();
  appendUser(h.manager, corrected.sentence);
  await h.runner.emitInput(written.sentence, undefined, "interactive", "followUp");
  appendCall(h.manager, corrected);
  const result = await h.execute(corrected);
  const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, h.theme, {});
  assert.equal(collapsed.render(100).join("\n").trimEnd(), "Language lesson saved. Use /lesson to show it.");
  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, h.theme, {});
  assert.match(expanded.render(100).join("\n"), /Suggestion: He goes/);
});

test("a grammatical sentence includes a revised alternative without claiming a grammar error", async () => {
  const h = harness();
  const result = await h.execute(grammatical);
  assert.deepEqual(result.details.lesson, grammatical);
  assert.match(result.content[0].text, /Suggestion: Please fix the bug\./);
  assert.match(h.text(), /Original: Fix the bug\./);
  assert.match(h.text(), /Suggestion: Please fix the bug\./);
  assert.match(h.text(), /The original is a correct command/);
});

for (const [medium, lesson] of [
  ["spoken", spoken],
  ["written", written],
]) {
  test(`a correct sentence can receive a ${medium} wording suggestion`, async () => {
    const h = harness();
    const result = await h.execute(lesson);
    assert.deepEqual(result.details.lesson, lesson);
    assert.ok(result.content[0].text.includes(`Suggestion: ${lesson.correction}`));
    assert.ok(h.text().includes(`Original: ${lesson.sentence}`));
    assert.ok(h.text().includes(`Suggestion: ${lesson.correction}`));
    assert.match(h.text(), /The original is correct/);
  });
}

test("new lessons accept sentence, revision, and explanation length limits", async () => {
  const h = harness();
  const lesson = {
    sentence: "a".repeat(300),
    correction: "b".repeat(300),
    explanation: "文".repeat(240),
  };
  const result = await h.execute(lesson);
  assert.deepEqual(result.details.lesson, lesson);
  assert.ok(result.content[0].text.includes(lesson.correction));
  assert.ok(h.component().render(80).length <= 6);
});

for (const [field, limit, character] of [
  ["sentence", 300, "😀"],
  ["correction", 300, "😀"],
  ["explanation", 240, "𠀀"],
]) {
  test(`${field} uses the same Unicode code-point limit as Pi argument validation`, async () => {
    const h = harness();
    const lesson = { ...corrected, [field]: character.repeat(limit) };
    const call = (args) => ({ type: "toolCall", id: `unicode-${field}`, name: tool.name, arguments: args });
    const params = validateToolArguments(tool, call(lesson));
    const result = await h.execute(params);
    assert.deepEqual(result.details.lesson, lesson);
    const previous = h.widgets.get("english-grammar");
    const overflow = { ...lesson, [field]: character.repeat(limit + 1) };
    assert.throws(() => validateToolArguments(tool, call(overflow)));
    await assert.rejects(h.execute(overflow), /short sentence/);
    assert.equal(h.widgets.get("english-grammar"), previous);

    const displayed = h.text();
    appendLesson(h.manager, lesson);
    await h.runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(h.text(), displayed);
    assert.deepEqual(h.errors, []);
  });
}

test("display-empty Unicode fields fail without changing the previous widget", async () => {
  const h = harness();
  await h.execute(corrected);
  const previous = h.widgets.get("english-grammar");
  const writes = h.writes.length;
  for (const field of ["sentence", "correction", "explanation"]) {
    for (const value of ["\u200b", "\u200c", "\u200d", "\u2060", "\ufe0f", "\u0301", " \u001b[32m\u200b\u001b[0m "]) {
      await assert.rejects(
        h.execute({ ...corrected, [field]: value }),
        /short sentence/,
        `${field}: ${JSON.stringify(value)}`,
      );
      assert.equal(h.widgets.get("english-grammar"), previous);
      assert.equal(h.writes.length, writes);
    }
  }
});

test("visible Unicode text retains joiners, variation selectors, and combining marks", async () => {
  const h = harness();
  const lesson = {
    sentence: "I use cafe\u0301 and 👩‍💻 with ❤️.",
    correction: "I use cafe\u0301, 👩‍💻, and ❤️.",
    explanation: "原句正確；這裡只提供不同表達。",
  };
  const result = await h.execute(lesson);
  assert.deepEqual(result.details.lesson, lesson);
  const displayed = h.text(200);
  for (const text of ["cafe\u0301", "👩‍💻", "❤️"]) assert.ok(displayed.includes(text));
});

test("invalid fields fail without replacing the previous widget", async () => {
  const h = harness();
  await h.execute(corrected);
  const previous = h.widgets.get("english-grammar");
  for (const lesson of [
    { ...corrected, sentence: " " },
    { ...corrected, sentence: "a".repeat(301) },
    { sentence: corrected.sentence, explanation: corrected.explanation },
    { ...corrected, correction: undefined },
    { ...corrected, correction: null },
    { ...corrected, correction: 42 },
    { ...corrected, correction: "" },
    { ...corrected, correction: " " },
    { ...corrected, correction: "\u001b[31m\u001b[0m" },
    { ...corrected, correction: "a".repeat(301) },
    { ...corrected, explanation: "\u001b[31m\u001b[0m" },
    { ...corrected, explanation: "a".repeat(241) },
    { ...corrected, explanation: 42 },
  ]) {
    await assert.rejects(h.execute(lesson), /short sentence/);
    assert.equal(h.widgets.get("english-grammar"), previous);
  }
});

test("a cancelled call does not replace the previous widget", async () => {
  const h = harness();
  await h.execute(corrected);
  const previous = h.widgets.get("english-grammar");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.execute(grammatical, controller.signal), { name: "AbortError" });
  assert.equal(h.widgets.get("english-grammar"), previous);
});

for (const mode of ["rpc", "json", "print"]) {
  test(`${mode} returns a text lesson without terminal UI`, async () => {
    const h = harness(mode);
    for (const lesson of lessons) {
      const result = await h.execute(lesson);
      assert.deepEqual(result.details.lesson, lesson);
      assert.ok(result.content[0].text.includes(`Suggestion: ${lesson.correction}`));
    }
    const branch = structuredClone(h.manager.getBranch());
    assert.deepEqual(await h.runner.emitInput("Next message", undefined, "rpc"), { action: "continue" });
    await h.command();
    assert.deepEqual(h.manager.getBranch(), branch);
    await h.runner.emit({ type: "session_start", reason: "startup" });
    await h.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.errors, []);
  });
}

test("narrow, wide-character, emoji, and resized widgets stay within six rows and the cell width", async () => {
  const h = harness();
  await h.execute({
    sentence: "Use 👩‍💻 and café in the 中文 example. ".repeat(5),
    correction: "Use the 👩‍💻 and café examples. ".repeat(5),
    explanation: "這是一個簡單的文法解說。".repeat(15),
  });
  const widget = h.component();
  for (const width of [0, 1, 2, 3, 8, 20, 80, 200, 8]) {
    widget.invalidate();
    const lines = widget.render(width);
    assert.ok(lines.length <= 6);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  assert.ok(h.text(20).includes("…"));
});

test("terminal controls are removed only from display, with raw fields retained", async () => {
  const h = harness();
  const sentence = "\u001b]8;;https://example.com\u0007He\u001b]8;;\u0007 go\u001b[2J\tto work.\r\n";
  const correction = "\u001b[32mHe goes to work.\u001b[0m";
  const explanation = "\u001b_Ghidden\u001b\\主詞是 he。\u0007";
  const result = await h.execute({ sentence, correction, explanation });
  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, h.theme, {});
  for (const displayed of [h.text(), expanded.render(80).join("\n")]) {
    assert.doesNotMatch(displayed.replaceAll("\n", ""), /\p{Cc}/u);
    assert.doesNotMatch(displayed, /hidden|https:\/\/example/);
    assert.match(displayed, /He go to work/);
    assert.match(displayed, /Suggestion: He goes to work/);
  }
  assert.equal(result.details.lesson.sentence, sentence);
  assert.equal(result.details.lesson.correction, correction);
  assert.equal(result.details.lesson.explanation, explanation);
});

test("widget invalidation uses the current callback theme without cached colors", async () => {
  const h = harness();
  await h.execute(corrected);
  const widget = h.component();
  h.setColor("\u001b[31m");
  assert.ok(widget.render(80).join("").includes("\u001b[31m"));
  h.setColor("\u001b[32m");
  widget.invalidate();
  const rendered = widget.render(80).join("");
  assert.ok(rendered.includes("\u001b[32m"));
  assert.ok(!rendered.includes("\u001b[31m"));
});

test("startup, reload, and tree navigation restore only the active branch's latest successful lesson", async () => {
  const h = harness();
  const root = h.manager.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
  appendLesson(h.manager, corrected);
  const selected = appendLesson(h.manager, grammatical);
  appendLesson(h.manager, { sentence: "Invalid" });
  appendLesson(h.manager, corrected, { isError: true });
  appendLesson(h.manager, corrected, { toolName: "another_tool" });
  for (const field of ["sentence", "correction", "explanation"]) {
    appendLesson(h.manager, { ...corrected, [field]: "\u200b" });
  }
  for (const details of [undefined, null, false, 42, "Invalid", [], {}, { lesson: null }]) {
    appendLesson(h.manager, corrected, { details });
  }
  for (const reason of ["startup", "reload"]) {
    await h.runner.emit({ type: "session_start", reason });
    assert.match(h.text(), /Fix the bug/);
  }
  h.manager.branch(root);
  await h.runner.emit({ type: "session_tree", newLeafId: root, oldLeafId: selected });
  assert.equal(h.widgets.has("english-grammar"), false);
  appendLesson(h.manager, corrected);
  await h.runner.emit({ type: "session_tree", newLeafId: h.manager.getLeafId(), oldLeafId: root });
  assert.match(h.text(), /He goes/);
  assert.deepEqual(h.errors, []);
});

test("legacy tool results restore and follow branch order alongside renamed-tool results", async () => {
  const h = harness();
  const legacy = appendLesson(h.manager, corrected, { toolName: "teach_english" });
  for (const reason of ["startup", "reload"]) {
    await h.runner.emit({ type: "session_start", reason });
    assert.match(h.text(), /He goes/);
  }
  const current = appendLesson(h.manager, grammatical);
  await h.runner.emit({ type: "session_start", reason: "reload" });
  assert.match(h.text(), /Please fix the bug/);
  h.manager.branch(legacy);
  await h.runner.emit({ type: "session_tree", newLeafId: legacy, oldLeafId: current });
  assert.match(h.text(), /He goes/);
  assert.equal(h.manager.getBranch().at(-1).message.toolName, "teach_english");
  assert.deepEqual(h.errors, []);
});

test("older Chinese lessons without a revised sentence restore unchanged with English labels", async () => {
  const h = harness();
  await h.execute(corrected);
  const legacy = { sentence: grammatical.sentence, explanation: "原句是正確的祈使句。" };
  appendLesson(h.manager, legacy, { toolName: "teach_english" });
  for (const event of [
    { type: "session_start", reason: "startup" },
    { type: "session_start", reason: "reload" },
    { type: "session_tree", newLeafId: h.manager.getLeafId(), oldLeafId: null },
  ]) {
    await h.runner.emit(event);
    assert.match(h.text(), /Original: Fix the bug\./);
    assert.ok(h.text().includes(`Explanation: ${legacy.explanation}`));
    assert.doesNotMatch(h.text(), /Suggestion:/);
  }
  const expanded = tool.renderResult(
    { content: [], details: { lesson: legacy } },
    { expanded: true, isPartial: false },
    h.theme,
    {},
  );
  assert.match(expanded.render(80).join("\n"), /Original: Fix the bug\./);
  assert.ok(expanded.render(80).join("\n").includes(`Explanation: ${legacy.explanation}`));
  assert.doesNotMatch(expanded.render(80).join("\n"), /Suggestion:/);
  assert.deepEqual(h.manager.getBranch().at(-1).message.details.lesson, legacy);
  assert.deepEqual(h.errors, []);
});

test("session replacement does not share widget state and shutdown cleanup is idempotent", async () => {
  const first = harness();
  await first.execute(corrected);
  first.widgets.set("unrelated", ["Keep this widget"]);
  for (let index = 0; index < 2; index++) {
    await first.runner.emit({ type: "session_shutdown", reason: "new" });
  }
  assert.equal(first.widgets.has("english-grammar"), false);
  assert.deepEqual(first.widgets.get("unrelated"), ["Keep this widget"]);
  const second = harness();
  await second.runner.emit({ type: "session_start", reason: "startup" });
  assert.equal(second.widgets.has("english-grammar"), false);
});

test("failed restoration clears stale UI before reporting an error", async () => {
  const h = harness();
  await h.execute(corrected);
  h.manager.getBranch = () => {
    throw new Error("Cannot read branch");
  };
  await h.runner.emit({ type: "session_start", reason: "reload" });
  assert.equal(h.widgets.has("english-grammar"), false);
  assert.equal(h.errors.length, 1);
});

test("calls and lifecycle events do not change the model-facing definition", async () => {
  const before = JSON.stringify({ description: tool.description, parameters: tool.parameters });
  const h = harness();
  await h.execute(corrected);
  await h.runner.emit({ type: "session_start", reason: "reload" });
  await h.runner.emitInput("Next message", undefined, "interactive");
  await h.execute(grammatical);
  assert.equal(JSON.stringify({ description: tool.description, parameters: tool.parameters }), before);
});

test("tool renderers handle partial arguments and sanitize errors without creating an editor", () => {
  const h = harness();
  assert.match(tool.renderCall({}, h.theme, {}).render(80).join(""), /Language lesson/);
  const failure = tool.renderResult(
    { content: [{ type: "text", text: "\u001b[2JFailure\u0007" }], details: undefined },
    { expanded: false, isPartial: false },
    h.theme,
    {},
  );
  assert.doesNotMatch(failure.render(80).join(""), /\p{Cc}/u);
  const expanded = tool.renderResult(
    { content: [], details: { lesson: corrected } },
    { expanded: true, isPartial: false },
    h.theme,
    {},
  );
  for (const width of [0, 1, 2, 20, 80]) {
    expanded.invalidate();
    for (const line of expanded.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  assert.match(expanded.render(80).join("\n"), /daily habit/);
});

test("trusted project discovery keeps lessons model-only and SDK reload restores them without a provider request", async () => {
  const agentDir = join(sandbox, "discovery-agent");
  const extensionDir = join(sandbox, ".pi", "extensions", "language-coach");
  mkdirSync(extensionDir, { recursive: true });
  copyFileSync(entrypoint, join(extensionDir, "index.ts"));
  const untrustedLoader = resourceLoader(agentDir, false, false);
  try {
    await untrustedLoader.reload();
    assert.deepEqual(untrustedLoader.getExtensions().errors, []);
    assert.equal(untrustedLoader.getExtensions().extensions.length, 0);
  } finally {
    untrustedLoader.getExtensions().runtime.invalidate("Test cleanup");
  }
  const discoveryLoader = resourceLoader(agentDir, false);
  await discoveryLoader.reload();
  assert.deepEqual(discoveryLoader.getExtensions().errors, []);
  assert.equal(discoveryLoader.getExtensions().extensions.length, 1);
  const manager = sdk.SessionManager.inMemory(sandbox);
  appendLesson(manager, corrected, { toolName: "teach_english" });
  const { session } = await sdk.createAgentSession({
    cwd: sandbox,
    agentDir,
    sessionManager: manager,
    settingsManager: sdk.SettingsManager.inMemory({}),
    resourceLoader: discoveryLoader,
  });
  const ui = uiHarness();
  try {
    await session.bindExtensions({ uiContext: ui.ui, mode: "tui" });
    assert.ok(session.getActiveToolNames().includes("teach_language"));
    assert.equal(session.getActiveToolNames().includes("teach_english"), false);
    assert.equal(session.getCallableToolNames().includes("teach_language"), false);
    assert.match(ui.text(), /He goes/);
    const count = ui.writes.length;
    await session.reload();
    assert.ok(ui.writes.length > count);
    assert.ok(session.getActiveToolNames().includes("teach_language"));
    assert.equal(session.getActiveToolNames().includes("teach_english"), false);
    assert.equal(session.getCallableToolNames().includes("teach_language"), false);
    assert.match(ui.text(), /He goes/);
    await session.steer("Next message");
    assert.equal(ui.widgets.has("english-grammar"), false);
    await session.reload();
    assert.equal(ui.widgets.has("english-grammar"), false);
    await session.prompt("/lesson");
    assert.match(ui.text(), /He goes/);
    await session.reload();
    assert.match(ui.text(), /He goes/);
  } finally {
    session.dispose();
  }
});
