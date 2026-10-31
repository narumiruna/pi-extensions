import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { TuiHarness } from "@narumitw/pi-tui-kit/testing";
import { DEFAULT_STAMP_SETTINGS } from "../src/format.js";
import { createMessageMetadataReader } from "../src/message-metadata.js";
import type { StampMetadataPreset } from "../src/metadata-settings.js";
import { createStampDisplaySettings } from "../src/preset-preview.js";
import {
  createStampSettingsRuntime,
  type StampSettingsPatch,
  type StampSettingsRuntime,
  type StampSettingsState,
} from "../src/settings.js";
import { createStampEntryRenderer, STAMP_ENTRY_TYPE, type StampEntryData } from "../src/stamp.js";

export const PRESET_DESCRIPTIONS = [
  "Model, thinking, total tokens, cost, and abnormal stops.",
  "Requested and response models, plus thinking level.",
  "Input, output, reasoning, cache, and total tokens.",
  "Reported cost per assistant call.",
  "Length limits, errors, and aborted responses.",
  "Full provenance, token counts, cost, and stop reasons.",
  "Hide assistant metadata.",
];
export const PRESET_LABELS = ["Compact", "Model", "Usage", "Cost", "Abnormal", "Detailed", "None"];
export const PRESET_LINES = [
  "TUI: move to apply temporarily. Confirm to save.",
  "Other settings unchanged. Response ID and diagnostics stay off.",
];
export const UTC_SETTINGS = { locale: "invariant", timeZone: "UTC", dateContext: "always" } as const;

export const NONMETADATA_SETTINGS: StampSettingsPatch = {
  hourCycle: "12h",
  showSeconds: false,
  dateContext: "always",
  locale: "fr-FR",
  timeZone: "Asia/Taipei",
  responseTiming: "detailed",
  showOutputThroughput: true,
  showExactTimeline: false,
  showCostSinceUser: true,
  showTimeSinceUser: true,
  toolStamps: true,
};

export function currentOwner(controller = new AbortController()) {
  return { signal: controller.signal, isCurrent: () => true };
}

export async function waitForPresetSave(tui: TuiHarness) {
  while (true) {
    await tui.waitForOpen();
    if (!tui.isOpen) continue;
    if (!tui.render().some((line) => line.includes("Saving Stamp preset"))) return;
    const completion = tui.resultPromise;
    await completion;
  }
}

export function memorySettingsRuntime(
  options: {
    settings?: StampSettingsPatch;
    path?: string;
    invalid?: boolean;
    beforeUpdate?(patch: StampSettingsPatch): Promise<void>;
  } = {},
): StampSettingsRuntime & { patches: StampSettingsPatch[]; replaceSettings(patch: StampSettingsPatch): void } {
  const settings = { ...DEFAULT_STAMP_SETTINGS, ...options.settings };
  let state: StampSettingsState = {
    settings,
    sources: Object.fromEntries(
      Object.keys(settings).map((key) => [key, Object.hasOwn(options.settings ?? {}, key) ? "user" : "built-in"]),
    ) as StampSettingsState["sources"],
    ...(options.invalid ? { issue: { kind: "invalid" as const, message: "bad settings" } } : {}),
    canSave: !options.invalid,
  };
  const patches: StampSettingsPatch[] = [];
  return {
    patches,
    replaceSettings(patch) {
      state = { ...state, settings: { ...state.settings, ...patch } };
    },
    get: () => state,
    getPath: () => options.path ?? "/tmp/pi-stamp.json",
    reload: async () => state,
    update: async (patch) => {
      patches.push({ ...patch });
      await options.beforeUpdate?.(patch);
      state = {
        ...state,
        settings: { ...state.settings, ...patch },
        sources: { ...state.sources, ...Object.fromEntries(Object.keys(patch).map((key) => [key, "user"])) },
      };
      return state;
    },
    flush: async () => undefined,
  };
}

const RECORDED_AT = Date.UTC(2026, 9, 30, 14, 32, 8);
export const RESPONSE_MESSAGE = {
  role: "assistant" as const,
  timestamp: RECORDED_AT,
  content: [{ type: "text" as const, text: "Actual response content must not enter the preview." }],
  api: "actual-api",
  provider: "actual-provider",
  model: "actual-request",
  responseModel: "actual-response",
  responseId: "actual-sensitive-id",
  thinkingLevel: "max" as const,
  stopReason: "length" as const,
  usage: {
    input: 900,
    output: 120,
    reasoning: 30,
    cacheRead: 70,
    cacheWrite: 20,
    totalTokens: 1_110,
    cost: { input: 0.01, output: 0.01, cacheRead: 0.002, cacheWrite: 0.002, total: 0.024 },
  },
};
export const RESPONSE_METADATA_ROWS: Record<StampMetadataPreset, readonly string[]> = {
  none: [],
  compact: ["actual-request → actual-response · stop length · 1,110 tok · est $0.024"],
  detailed: [
    "api actual-api · provider actual-provider · requested actual-request · response actual-response · stop length",
    "tokens in 900 · out 120 · reasoning 30 · cache read 70 · cache write 20 · total 1,110 · est cost $0.024",
  ],
  model: ["actual-request → actual-response"],
  usage: ["tokens in 900 · out 120 · reasoning 30 · cache read 70 · cache write 20 · total 1,110"],
  cost: ["est $0.024"],
  abnormal: ["stop length"],
};

const RECORDED_STAMPS = {
  user: { version: 2, role: "user", timestamp: RECORDED_AT - 48_000 },
  assistant: {
    version: 8,
    role: "assistant",
    timestamp: RECORDED_AT,
    completedAt: RECORDED_AT + 3_200,
    firstContentAt: RECORDED_AT + 800,
    outputTokens: 160,
    timeSinceUserMs: 51_200,
    thinkingLevel: "high",
    estimatedCost: 0.018,
    costSinceUser: 0.039,
    metadata: {
      api: "recorded-api",
      provider: "recorded-provider",
      model: "recorded-request",
      responseModel: "recorded-response",
      responseId: "recorded-id",
      stopReason: "length",
      usage: {
        input: 600,
        output: 160,
        reasoning: 40,
        cacheRead: 80,
        cacheWrite: 40,
        totalTokens: 880,
        estimatedCost: 0.018,
      },
      diagnosticCount: 1,
      diagnostics: [{ type: "recorded-diagnostic", errorName: "RecordedError", errorCode: "RECORDED" }],
    },
  },
  legacy: { version: 2, role: "assistant", timestamp: RECORDED_AT + 4_000 },
  sparse: {
    version: 4,
    role: "assistant",
    timestamp: RECORDED_AT + 5_000,
    metadata: { api: "sparse-api", provider: "sparse-provider", model: "sparse-model", stopReason: "stop" },
  },
  tool: {
    version: 1,
    kind: "tool",
    toolCallId: "recorded-call",
    toolName: "read",
    startedAt: RECORDED_AT + 6_000,
    completedAt: RECORDED_AT + 7_250,
    outcome: "success",
  },
} as const satisfies Record<string, StampEntryData>;

/** Mount real transcript entries; saved Stamp metadata must take priority over the response. */
export async function mountedPreviewFixture(
  settings: StampSettingsPatch = {},
  beforeSave?: () => Promise<void>,
  options: {
    assistantStamp?: "recorded" | "timestamp-only";
    assistantMessage?: "reported" | "no-data" | "none";
  } = {},
) {
  const directory = mkdtempSync(join(os.tmpdir(), "pi-stamp-mounted-preview-"));
  const path = join(directory, "pi-stamp.json");
  writeFileSync(
    path,
    `${JSON.stringify({ ...UTC_SETTINGS, toolStamps: true, ...settings, futureField: { keep: true } })}\n`,
  );
  const runtime = createStampSettingsRuntime({
    path,
    operations: {
      rename: async (...args) => {
        await beforeSave?.();
        await rename(...args);
      },
    },
  });
  try {
    await runtime.reload();
    const display = createStampDisplaySettings(() => runtime.get().settings);
    const sessionManager = SessionManager.inMemory(directory);
    sessionManager.appendMessage({ role: "user", content: "Recorded prompt", timestamp: RECORDED_AT - 48_000 });
    const metadataReader = createMessageMetadataReader();
    metadataReader.bind(sessionManager);
    const renderer = createStampEntryRenderer(display.get, metadataReader.get);
    const themeCalls: { role: string; text: string }[] = [];
    const theme = {
      fg: (role: string, text: string) => {
        themeCalls.push({ role, text });
        return text;
      },
    } as never;
    const components = Object.fromEntries(
      Object.entries(RECORDED_STAMPS).flatMap(([name, recorded]): [string, Component][] => {
        if (name === "assistant" && options.assistantMessage !== "none") {
          sessionManager.appendMessage(
            structuredClone({
              ...RESPONSE_MESSAGE,
              ...(options.assistantMessage === "no-data" ? { api: "", provider: "", model: "" } : {}),
            }),
          );
        }
        const data =
          name === "assistant" && options.assistantStamp === "timestamp-only"
            ? { version: 2, role: "assistant", timestamp: RECORDED_AT }
            : recorded;
        const id = sessionManager.appendCustomEntry(STAMP_ENTRY_TYPE, structuredClone(data));
        const entry = sessionManager.getEntry(id);
        assert.ok(entry?.type === "custom");
        const collapsed = renderer(entry as never, { expanded: false }, theme);
        const expanded = renderer(entry as never, { expanded: true }, theme);
        assert.ok(collapsed);
        assert.ok(expanded);
        return [
          [name, collapsed],
          [`${name}Expanded`, expanded],
        ];
      }),
    );
    return {
      runtime,
      display,
      sessionManager,
      metadataReader,
      components,
      themeCalls,
      renderRaw(width = 160) {
        return Object.fromEntries(
          Object.entries(components).map(([name, component]) => [name, component.render(width)]),
        );
      },
      render(width = 160) {
        return Object.fromEntries(
          Object.entries(components).map(([name, component]) => [
            name,
            component.render(width).map((line) => line.trim()),
          ]),
        );
      },
      snapshot() {
        return {
          state: runtime.get(),
          file: readFileSync(path, "utf8"),
          files: readdirSync(directory).sort(),
          session: JSON.stringify(sessionManager.getEntries()),
          branch: JSON.stringify(sessionManager.getBranch()),
          leaf: sessionManager.getLeafId(),
          context: JSON.stringify(sessionManager.buildSessionContext()),
        };
      },
      dispose() {
        metadataReader.clear();
        display.clear();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
