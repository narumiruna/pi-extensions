import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadSettings } from "../src/config.js";
import { createOtelExtension } from "../src/otel.js";
import { FakeBackend } from "./support.js";

test.each(["tui", "rpc"])("/langfuse warns and opens the /otel menu in %s", async (mode) => {
  const backend = new FakeBackend();
  const mock = createMockPi();
  createOtelExtension({
    loadConfig: async () => ({
      ok: true,
      config: {
        publicKey: "pk-private-value",
        secretKey: "sk-private-value",
        baseUrl: "https://example.test",
        captureContent: true,
      },
      path: "/private/pi-otel.json",
      warnings: [],
    }),
    createBackend: async () => backend,
  })(mock.pi);
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const { ctx, notifications } = createMockContext({
    mode,
    hasUI: true,
    select: async (title: string, options: string[]) => {
      selectCalls.push({ title, options });
      return undefined;
    },
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  const command = mock.commands.get("otel");
  const alias = mock.commands.get("langfuse");
  assert.ok(command && alias);
  assert.match(alias.description ?? "", /Deprecated.*\/otel/u);
  await command.handler("", ctx);
  assert.deepEqual(notifications, []);
  await alias.handler("legacy arguments are ignored", ctx);

  assert.deepEqual(notifications, [{ message: "/langfuse is deprecated. Use /otel instead.", level: "warning" }]);
  assert.deepEqual(selectCalls[0], selectCalls[1]);
  assert.equal(command.getArgumentCompletions, undefined);
  assert.match(selectCalls[0]?.title ?? "", /Current session:\nTracing: enabled/);
  assert.match(selectCalls[0]?.title ?? "", /Endpoint: https:\/\/example\.test/);
  assert.match(selectCalls[0]?.title ?? "", /Content capture: enabled/);
  assert.match(selectCalls[0]?.title ?? "", /Configuration: \/private\/pi-otel\.json/);
  assert.match(selectCalls[0]?.title ?? "", /this Pi agent directory.*restart each Pi process/i);
  assert.deepEqual(selectCalls[0]?.options, [
    "Flush completed traces for this session",
    "Update Langfuse for this Pi agent directory (restart required)",
    "Settings (edit private file)",
    "Show setup and privacy help",
  ]);
  assert.doesNotMatch(selectCalls[0]?.title ?? "", /private-value/);
});

test("/langfuse routes the current-session flush action and waits for export", async () => {
  const backend = new FakeBackend();
  let releaseFlush: (() => void) | undefined;
  backend.forceFlush = () =>
    new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
  const mock = createMockPi();
  createOtelExtension({
    loadConfig: async () => ({
      ok: true,
      config: {
        publicKey: "pk",
        secretKey: "sk",
        baseUrl: "https://example.test",
        captureContent: true,
      },
      path: "/private/pi-otel.json",
      warnings: [],
    }),
    createBackend: async () => backend,
  })(mock.pi);
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    select: async () => "Flush completed traces for this session",
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  const flush = mock.commands.get("langfuse")?.handler("flush", ctx) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    notifications.some(({ message }) => /flushed/.test(message)),
    false,
  );
  releaseFlush?.();
  await flush;
  assert.match(notifications.at(-1)?.message ?? "", /flushed/i);
});

test("/langfuse does not apply a pending menu choice after the session changes", async () => {
  const firstBackend = new FakeBackend();
  const secondBackend = new FakeBackend();
  const backends = [firstBackend, secondBackend];
  let choose: ((choice: string) => void) | undefined;
  const mock = createMockPi();
  createOtelExtension({
    loadConfig: async () => ({
      ok: true,
      config: {
        publicKey: "pk",
        secretKey: "sk",
        baseUrl: "https://example.test",
        captureContent: true,
      },
      path: "/private/pi-otel.json",
      warnings: [],
    }),
    createBackend: async () => backends.shift() ?? secondBackend,
  })(mock.pi);
  const { ctx } = createMockContext({
    hasUI: true,
    select: async () =>
      new Promise<string>((resolve) => {
        choose = resolve;
      }),
  });
  const sessionStart = mock.events.get("session_start")?.[0];
  await sessionStart?.({}, ctx);
  const pending = mock.commands.get("langfuse")?.handler("", ctx) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));

  await sessionStart?.({}, ctx);
  assert.ok(choose);
  choose("Flush completed traces for this session");
  await pending;

  assert.equal(firstBackend.flushes, 0);
  assert.equal(secondBackend.flushes, 0);
});

test("/langfuse does not apply a pending menu choice after session shutdown", async () => {
  const backend = new FakeBackend();
  let choose: ((choice: string) => void) | undefined;
  const mock = createMockPi();
  createOtelExtension({
    loadConfig: async () => ({
      ok: true,
      config: {
        publicKey: "pk",
        secretKey: "sk",
        baseUrl: "https://example.test",
        captureContent: true,
      },
      path: "/private/pi-otel.json",
      warnings: [],
    }),
    createBackend: async () => backend,
  })(mock.pi);
  const { ctx } = createMockContext({
    hasUI: true,
    select: async () =>
      new Promise<string>((resolve) => {
        choose = resolve;
      }),
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  const pending = mock.commands.get("langfuse")?.handler("", ctx) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));

  await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
  assert.ok(choose);
  choose("Flush completed traces for this session");
  await pending;

  assert.equal(backend.flushes, 1);
  assert.equal(backend.shutdowns, 1);
});

test("/langfuse redacts configured keys from flush failures", async () => {
  const backend = new FakeBackend();
  backend.forceFlush = async () => {
    throw new Error("flush exposed pk-private-ui and sk-private-ui");
  };
  const mock = createMockPi();
  createOtelExtension({
    loadConfig: async () => ({
      ok: true,
      config: {
        publicKey: "pk-private-ui",
        secretKey: "sk-private-ui",
        baseUrl: "https://example.test",
        captureContent: true,
      },
      path: "/private/pi-otel.json",
      warnings: [],
    }),
    createBackend: async () => backend,
  })(mock.pi);
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    select: async () => "Flush completed traces for this session",
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  await mock.commands.get("langfuse")?.handler("", ctx);

  const message = notifications.at(-1)?.message ?? "";
  assert.match(message, /flush exposed/);
  assert.match(message, /LANGFUSE_KEY_REDACTED/);
  assert.doesNotMatch(message, /pk-private-ui|sk-private-ui/);
});

test("/otel disabled state prioritizes agent-directory setup and routes privacy help", async () => {
  const mock = createMockPi();
  createOtelExtension({
    loadConfig: async () => ({
      ok: false,
      path: "/config/pi-otel.json",
      warnings: [],
      reason: "Configuration file not found: /config/pi-otel.json",
    }),
    createBackend: async () => new FakeBackend(),
  })(mock.pi);
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    select: async (title: string, options: string[]) => {
      selectCalls.push({ title, options });
      return "Show setup and privacy help";
    },
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  await mock.commands.get("otel")?.handler("", ctx);

  assert.match(selectCalls[0]?.title ?? "", /Current session:\nTracing: disabled/);
  assert.match(selectCalls[0]?.title ?? "", /Configuration file not found/);
  assert.deepEqual(selectCalls[0]?.options, [
    "Set up Langfuse for this Pi agent directory (restart required)",
    "Settings (edit private file)",
    "Show setup and privacy help",
  ]);
  assert.match(notifications.at(-1)?.message ?? "", /trace content may contain/i);
  assert.match(notifications.at(-1)?.message ?? "", /git branch.*remain in metadata/i);
  assert.match(notifications.at(-1)?.message ?? "", /\/config\/pi-otel\.json/);
});

test("/otel interactively creates and updates a private Langfuse configuration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-init-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "nested", "pi-otel.json");
  const mock = createMockPi();
  createOtelExtension({
    loadConfig: (requestedPath = path) => loadSettings(requestedPath),
    createBackend: async () => new FakeBackend(),
  })(mock.pi);
  const session = createMockContext({ hasUI: false });
  await mock.events.get("session_start")?.[0]?.({}, session.ctx);
  const command = mock.commands.get("otel");
  assert.ok(command);
  const prompts: Array<{ title: string; placeholder?: string }> = [];
  const menuTitles: string[] = [];
  const answers = ["sk-new", "pk-new", ""];
  const selections = [
    "Set up Langfuse for this Pi agent directory (restart required)",
    "Update Langfuse for this Pi agent directory (restart required)",
  ];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async (title: string) => {
      menuTitles.push(title);
      return selections.shift();
    },
    input: async (title: string, placeholder?: string) => {
      prompts.push({ title, placeholder });
      return answers.shift();
    },
  });

  await command.handler("", context.ctx);

  assert.deepEqual(
    prompts.slice(0, 3).map(({ title }) => title),
    [
      "Langfuse secret key (leave blank to keep existing):",
      "Langfuse public key (leave blank to keep existing):",
      "Langfuse base URL (leave blank for default https://us.cloud.langfuse.com):",
    ],
  );
  assert.equal(prompts[2]?.placeholder, "https://us.cloud.langfuse.com");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    publicKey: "pk-new",
    secretKey: "sk-new",
    baseUrl: "https://us.cloud.langfuse.com",
    captureContent: true,
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(context.notifications.at(-1)?.message ?? "", /this Pi agent directory.*restart each Pi process/i);
  assert.equal(context.notifications.at(-1)?.level, "info");

  answers.push("", "", "https://self-hosted.example/");
  await command.handler("", context.ctx);
  assert.match(menuTitles[1] ?? "", /State: tracing remains disabled until Pi restarts/i);
  assert.match(menuTitles[1] ?? "", /Pending: Saved; restart each Pi process to use it in subsequent sessions/i);
  assert.doesNotMatch(menuTitles[1] ?? "", /Reason:|Configuration file not found/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    publicKey: "pk-new",
    secretKey: "sk-new",
    baseUrl: "https://self-hosted.example",
    captureContent: true,
  });
});

test("/langfuse keeps an active session on its original connection after an update", async () => {
  const backend = new FakeBackend();
  const originalConfig = {
    publicKey: "pk-original",
    secretKey: "sk-original",
    baseUrl: "https://original.example",
    captureContent: true,
  };
  let backendCreations = 0;
  let savedConfig: unknown;
  const menuCalls: Array<{ title: string; options: string[] }> = [];
  const selections = ["Update Langfuse for this Pi agent directory (restart required)", undefined];
  const answers = ["sk-updated", "pk-updated", "https://updated.example"];
  const mock = createMockPi();
  createOtelExtension({
    loadConfig: async () => ({
      ok: true,
      config: originalConfig,
      path: "/private/pi-otel.json",
      warnings: [],
    }),
    writeConfig: async (config) => {
      savedConfig = config;
      return config;
    },
    createBackend: async () => {
      backendCreations += 1;
      return backend;
    },
  })(mock.pi);
  const { ctx } = createMockContext({
    hasUI: true,
    select: async (title: string, options: string[]) => {
      menuCalls.push({ title, options });
      return selections.shift();
    },
    input: async () => answers.shift(),
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  const command = mock.commands.get("langfuse");

  await command?.handler("", ctx);
  await command?.handler("", ctx);

  assert.deepEqual(savedConfig, {
    publicKey: "pk-updated",
    secretKey: "sk-updated",
    baseUrl: "https://updated.example",
  });
  assert.equal(backendCreations, 1);
  assert.match(menuCalls[1]?.title ?? "", /Endpoint: https:\/\/original\.example/);
  assert.match(menuCalls[1]?.title ?? "", /Content capture: enabled/);
  assert.match(menuCalls[1]?.title ?? "", /Pending: Saved; restart each Pi process/i);
  assert.deepEqual(menuCalls[1]?.options, [
    "Flush completed traces for this session",
    "Update Langfuse for this Pi agent directory (restart required)",
    "Settings (edit private file)",
    "Show setup and privacy help",
  ]);
});

test("/langfuse redacts entered keys from configuration save failures", async () => {
  const mock = createMockPi();
  createOtelExtension({
    loadConfig: async () => ({
      ok: false,
      path: "/private/pi-otel.json",
      warnings: [],
      reason: "missing",
    }),
    writeConfig: async (config) => {
      throw new Error(`write exposed ${config.publicKey} and ${config.secretKey}`);
    },
    createBackend: async () => new FakeBackend(),
  })(mock.pi);
  const answers = ["sk-private-ui", "pk-private-ui", "https://example.test"];
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    select: async () => "Set up Langfuse for this Pi agent directory (restart required)",
    input: async () => answers.shift(),
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  await mock.commands.get("langfuse")?.handler("", ctx);

  const message = notifications.at(-1)?.message ?? "";
  assert.match(message, /write exposed/);
  assert.match(message, /LANGFUSE_KEY_REDACTED/);
  assert.doesNotMatch(message, /pk-private-ui|sk-private-ui/);
});

test("/langfuse ignores arguments but requires interactive UI", async () => {
  const mock = createMockPi();
  createOtelExtension({
    loadConfig: async () => ({
      ok: false,
      path: "/config/pi-otel.json",
      warnings: [],
      reason: "missing",
    }),
    createBackend: async () => new FakeBackend(),
  })(mock.pi);
  for (const mode of ["print", "json"]) {
    const { ctx } = createMockContext({ hasUI: false, mode });
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    const langfuse = mock.commands.get("langfuse");
    const otel = mock.commands.get("otel");
    assert.ok(langfuse && otel);
    for (const [command, args] of [
      [langfuse, "flush"],
      [otel, ""],
    ] as const) {
      await assert.rejects(
        async () => command.handler(args, ctx),
        /requires interactive UI[\s\S]*Current session tracing: disabled[\s\S]*\/config\/pi-otel\.json/u,
      );
    }
  }
});

test.each(["tui", "rpc"])("/otel provides collector status, settings, help, and flush in %s", async (mode) => {
  const backend = new FakeBackend();
  backend.forceFlush = async () => {
    throw new Error("Failure with private-token and x-private-key");
  };
  const config = {
    backend: "otlp" as const,
    endpoint: "https://example.test/private-path/v1/traces",
    headers: { authorization: "Bearer private-token", "x-api-key": "x-private-key" },
    serviceName: "pi",
    captureContent: false,
  };
  const mock = createMockPi();
  createOtelExtension({
    loadConfig: async () => ({ ok: true, config, path: "/config/pi-otel.json", warnings: [] }),
    createBackend: async () => backend,
  })(mock.pi);
  const titles: string[] = [];
  const selections: string[][] = [];
  const choices = [
    "Settings (edit private file)",
    "Show setup and privacy help",
    "Flush completed traces for this session",
  ];
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    mode,
    select: async (title: string, options: string[]) => {
      titles.push(title);
      selections.push(options);
      return choices.shift();
    },
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  const command = mock.commands.get("otel");
  assert.ok(command);
  await assert.rejects(async () => command.handler("flush extra", ctx), /takes no arguments/u);
  assert.equal(titles.length, 0);
  await command.handler("", ctx);
  assert.match(notifications.at(-1)?.message ?? "", /Edit the private settings file:.*pi-otel\.json/u);
  await command.handler("", ctx);
  assert.match(notifications.at(-1)?.message ?? "", /full traces endpoint/u);
  await command.handler("", ctx);
  assert.match(
    notifications.at(-1)?.message ?? "",
    /OTLP flush failed: Failure with \[OTLP_SECRET_REDACTED\] and \[OTLP_SECRET_REDACTED\]/u,
  );
  assert.match(
    titles[0] ?? "",
    /Backend: OTLP[\s\S]*Endpoint origin: https:\/\/example\.test[\s\S]*Content capture: disabled/u,
  );
  assert.doesNotMatch(titles.join("\n"), /private-path|private-token|x-private-key/u);
  assert.deepEqual(selections[0], [
    "Flush completed traces for this session",
    "Settings (edit private file)",
    "Show setup and privacy help",
  ]);
});

test("/otel directs legacy settings to the canonical file instead of overwriting them", async () => {
  const mock = createMockPi();
  let inputCount = 0;
  let writeCount = 0;
  createOtelExtension({
    loadConfig: async () => ({
      ok: true,
      legacy: true,
      path: "/config/pi-langfuse.json",
      warnings: [],
      config: { publicKey: "test", secretKey: "keep", baseUrl: "https://example.test", captureContent: false },
    }),
    writeConfig: async () => {
      writeCount += 1;
    },
    createBackend: async () => new FakeBackend(),
  })(mock.pi);
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    select: async () => "Update Langfuse for this Pi agent directory (restart required)",
    input: async () => {
      inputCount += 1;
      return undefined;
    },
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await mock.commands.get("otel")?.handler("", ctx);
  assert.match(
    notifications.at(-1)?.message ?? "",
    /Read-only legacy settings: \/config\/pi-langfuse\.json.*pi-otel\.json/u,
  );
  assert.equal(inputCount, 0);
  assert.equal(writeCount, 0);
});
