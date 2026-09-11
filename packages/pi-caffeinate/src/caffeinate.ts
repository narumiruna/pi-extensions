import type { ChildProcess } from "node:child_process";
import process from "node:process";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type DbusScreenSaverClient,
  type DbusScreenSaverFactory,
  defaultDbusScreenSaverFactory,
  INHIBIT_REASON,
  SCREENSAVER_BUS_NAME,
} from "./dbus-inhibit.js";
import { startInhibitorProcess, stopInhibitorProcess } from "./inhibitor-process.js";
import { formatMode, getInhibitorCommand, type InhibitorCommand } from "./inhibitors.js";
import {
  type CaffeinateMode,
  type CaffeinateSettings,
  loadSettings,
  saveSettings,
  settingsFilePath,
} from "./settings.js";

const STATUS_KEY = "caffeinate";
const DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_MODE = "display" satisfies CaffeinateMode;
const COMMAND_COMPLETIONS = [
  { value: "display", label: "display", description: "Keep system and display awake" },
  { value: "sleep", label: "sleep", description: "Keep system awake; allow display sleep" },
  { value: "status", label: "status", description: "Show current status" },
  { value: "mode", label: "mode", description: "Choose keep-awake mode" },
  { value: "stop", label: "stop", description: "Release inhibitor for now" },
  { value: "help", label: "help", description: "Show command help" },
];
const MENU_OPTIONS = {
  display: "Keep system and display awake",
  sleep: "Keep system awake; allow display sleep",
  status: "Show current status",
  stop: "Release inhibitor for now",
  help: "Show command help",
} as const;
const MODE_OPTIONS = {
  display: "Keep system and display awake",
  sleep: "Keep system awake; allow display sleep",
} as const;

type CommandAction = "menu" | "help" | "status" | "mode" | "sleep" | "display" | "stop";
type CommandContext = ExtensionCommandContext;

interface CaffeinateOptions {
  dbusFactory?: DbusScreenSaverFactory;
}

interface PendingDbusStart {
  token: number;
  controller: AbortController;
  client?: DbusScreenSaverClient;
}

interface CaffeinateState {
  process?: ChildProcess;
  dbus?: DbusScreenSaverClient;
  currentSession?: { generation: number; ctx: ExtensionContext };
  dbusCleanup?: Promise<void>;
  pendingDbus?: PendingDbusStart;
  startedAt?: number;
  command?: InhibitorCommand;
  lastError?: string;
  inhibitWarning?: string;
  inhibitorStarting: boolean;
  activeTurns: number;
  available: boolean;
  disabled: boolean;
  mode: CaffeinateMode;
  quiet: boolean;
  settingsLoaded: boolean;
  settingsError?: string;
  settingsNotice?: string;
  iconWarningShown: boolean;
  sessionGeneration: number;
  menuController: AbortController;
}

const state: CaffeinateState = {
  activeTurns: 0,
  available: true,
  inhibitorStarting: false,
  disabled: isDisabled(),
  mode: DEFAULT_MODE,
  quiet: false,
  settingsLoaded: false,
  iconWarningShown: false,
  sessionGeneration: 0,
  menuController: new AbortController(),
};

let dbusFactory = defaultDbusScreenSaverFactory;
let inhibitSequence = 0;

export default function caffeinate(pi: ExtensionAPI, options: CaffeinateOptions = {}) {
  dbusFactory = options.dbusFactory ?? defaultDbusScreenSaverFactory;
  pi.on("session_start", async (_event, ctx) => {
    const generation = ++state.sessionGeneration;
    state.currentSession = { generation, ctx };
    replaceMenuController("Caffeinate session replaced");
    state.iconWarningShown = false;
    state.settingsNotice = undefined;
    warnDeprecatedIcon(ctx);
    await loadSettingsIntoState(ctx, generation);
    if (generation !== state.sessionGeneration) return;
    updateStatus(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    const generation = state.sessionGeneration;
    await ensureSettingsLoaded(ctx, generation);
    if (generation !== state.sessionGeneration) return;
    state.activeTurns += 1;
    await startInhibitor(ctx, generation, { notify: !state.quiet });
  });

  pi.on("agent_end", async (_event, ctx) => {
    const generation = state.sessionGeneration;
    state.activeTurns = Math.max(0, state.activeTurns - 1);
    if (state.activeTurns === 0) {
      await stopInhibitor(ctx, "agent finished", { notify: !state.quiet });
    }
    if (generation !== state.sessionGeneration) return;
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const generation = ++state.sessionGeneration;
    state.currentSession = undefined;
    state.menuController.abort(new DOMException("Caffeinate session shut down", "AbortError"));
    state.activeTurns = 0;
    await stopInhibitor(ctx, "session shutdown", { notify: false });
    await modeOperationQueue;
    if (generation !== state.sessionGeneration) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("caffeinate", {
    description: "Open pi-caffeinate keep-awake controls",
    getArgumentCompletions: (prefix) => commandCompletions(prefix),
    handler: async (args, ctx) => {
      const generation = state.sessionGeneration;
      const command = parseCommand(args);
      if (command === "sleep" || command === "display") {
        await setModeAfterSettingsLoad(ctx, command, generation);
        return;
      }
      await ensureSettingsLoaded(ctx, generation);
      if (generation !== state.sessionGeneration) return;
      await handleCaffeinateCommand(args, ctx, generation);
    },
  });
}

async function handleCaffeinateCommand(args: string, ctx: CommandContext, generation: number) {
  const command = parseCommand(args);
  switch (command) {
    case "menu":
      await showMenu(ctx, generation);
      return;
    case "help":
      ctx.ui.notify(buildCommandGuide(), "info");
      return;
    case "status":
      showStatus(ctx);
      return;
    case "mode":
      await showModeSelector(ctx, generation);
      return;
    case "sleep":
      await setMode(ctx, "sleep", generation);
      return;
    case "display":
      await setMode(ctx, "display", generation);
      return;
    case "stop":
      await stopCaffeinate(ctx, "manual stop", generation);
      return;
  }

  ctx.ui.notify(`Unknown /caffeinate command: ${args.trim()}\n\n${buildCommandGuide()}`, "warning");
}

async function showMenu(ctx: CommandContext, generation: number) {
  await runCaffeinateMenu(ctx, generation, "main");
}

async function showModeSelector(ctx: CommandContext, generation: number) {
  await runCaffeinateMenu(ctx, generation, "mode");
}

async function runCaffeinateMenu(ctx: CommandContext, generation: number, start: "main" | "mode") {
  if (!ctx.hasUI) {
    throw new Error(
      start === "mode"
        ? "Mode selection requires TUI or RPC mode. Use /caffeinate sleep or /caffeinate display."
        : `The pi-caffeinate menu requires TUI or RPC mode.\n\n${buildCommandGuide()}\n\n${describeState()}`,
    );
  }
  const menuSignal = state.menuController.signal;
  const isCurrent = () => generation === state.sessionGeneration && !menuSignal.aborted;
  const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
  if (!isCurrent()) return;
  type Screen = "main" | "mode";
  type Action = "display" | "sleep" | "status" | "stop" | "help";
  const menu = defineMenu<undefined, Screen, Action>({
    start,
    screens: {
      main: () => ({
        kind: "actions",
        title: "pi-caffeinate controls",
        lines: describeState().split("\n"),
        items: Object.entries(MENU_OPTIONS).map(([id, label]) => ({
          id,
          label,
          action: id as Action,
        })),
        hint: "close",
      }),
      mode: () => ({
        kind: "actions",
        title: `pi-caffeinate mode (current: ${formatMode(state.mode)})`,
        items: Object.entries(MODE_OPTIONS).map(([id, label]) => ({
          id,
          label,
          action: id as Action,
        })),
        hint: "close",
      }),
    },
    actions: {
      display: async () => {
        await setMode(ctx, "display", generation);
        return { kind: "close" };
      },
      sleep: async () => {
        await setMode(ctx, "sleep", generation);
        return { kind: "close" };
      },
      status: async () => {
        showStatus(ctx);
        return { kind: "close" };
      },
      stop: async () => {
        await stopCaffeinate(ctx, "manual stop", generation);
        return { kind: "close" };
      },
      help: async () => {
        ctx.ui.notify(buildCommandGuide(), "info");
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal: menuSignal,
    isCurrent,
  });
}

function replaceMenuController(reason: string) {
  state.menuController.abort(new DOMException(reason, "AbortError"));
  state.menuController = new AbortController();
}

let modeOperationQueue = Promise.resolve();

function setModeAfterSettingsLoad(ctx: ExtensionContext, mode: CaffeinateMode, generation: number): Promise<void> {
  return enqueueModeOperation(async () => {
    await ensureSettingsLoaded(ctx, generation);
    if (generation !== state.sessionGeneration) return;
    await setModeNow(ctx, mode, generation);
  });
}

function setMode(ctx: ExtensionContext, mode: CaffeinateMode, generation: number): Promise<void> {
  return enqueueModeOperation(() => setModeNow(ctx, mode, generation));
}

function enqueueModeOperation(operation: () => Promise<void>): Promise<void> {
  const queued = modeOperationQueue.then(operation);
  modeOperationQueue = queued.catch(() => undefined);
  return queued;
}

async function setModeNow(ctx: ExtensionContext, mode: CaffeinateMode, generation: number) {
  if (generation !== state.sessionGeneration) return;
  const previousMode = state.mode;
  const previousQuiet = state.quiet;
  const restartRequired = Boolean(hasActiveInhibitor() && previousMode !== mode && !state.command?.custom);
  state.settingsError = undefined;

  if (restartRequired) {
    state.mode = mode;
    await stopInhibitor(ctx, "mode changed", { notify: false });
    if (generation !== state.sessionGeneration) return;
    await startInhibitor(ctx, generation, { notify: false });
    if (generation !== state.sessionGeneration) return;
    if (!hasActiveInhibitor()) {
      const applicationError = state.lastError ?? "the inhibitor could not be restarted";
      state.mode = previousMode;
      await startInhibitor(ctx, generation, { notify: false });
      if (generation !== state.sessionGeneration) return;
      const rollbackError = hasActiveInhibitor()
        ? undefined
        : (state.lastError ?? "the previous inhibitor could not be restored");
      state.settingsError = rollbackError
        ? `mode application failed (${applicationError}); runtime rollback failed: ${rollbackError}`
        : `mode application failed and was rolled back: ${applicationError}`;
      ctx.ui.notify(`pi-caffeinate ${state.settingsError}`, "warning");
      updateStatus(ctx);
      return;
    }
  }

  let savedSettings: CaffeinateSettings;
  try {
    savedSettings = await saveSettings({ mode, updatedAt: Date.now() });
  } catch (error) {
    if (generation !== state.sessionGeneration) return;
    let rollbackError: string | undefined;
    if (restartRequired) {
      state.mode = previousMode;
      state.quiet = previousQuiet;
      await stopInhibitor(ctx, "settings save failed", { notify: false });
      if (generation !== state.sessionGeneration) return;
      await startInhibitor(ctx, generation, { notify: false });
      if (generation !== state.sessionGeneration) return;
      if (!hasActiveInhibitor()) {
        rollbackError = state.lastError ?? "the prior inhibitor was not restored";
      }
    }
    state.settingsError = rollbackError
      ? `settings save failed (${formatError(error)}); runtime rollback failed: ${rollbackError}`
      : `settings save failed: ${formatError(error)}`;
    ctx.ui.notify(
      `pi-caffeinate mode remains ${formatMode(previousMode)}; settings were not saved: ${state.settingsError}`,
      "warning",
    );
    updateStatus(ctx);
    return;
  }

  if (generation !== state.sessionGeneration) return;
  state.mode = mode;
  state.quiet = savedSettings.quiet;
  ctx.ui.notify(`pi-caffeinate mode set to ${formatMode(mode)} and saved.`, "info");
  updateStatus(ctx);
}

function showStatus(ctx: ExtensionContext) {
  ctx.ui.notify(describeState(), statusLevel());
  updateStatus(ctx);
}

async function stopCaffeinate(ctx: ExtensionContext, reason: string, sessionGeneration: number) {
  state.activeTurns = 0;
  await stopInhibitor(ctx, reason);
  if (sessionGeneration !== state.sessionGeneration) return;
  updateStatus(ctx);
}

export function parseCommand(args: string): CommandAction | "unknown" {
  const command = args.trim().toLowerCase();
  if (!command) return "menu";
  if (command === "help") return "help";
  if (command === "status") return "status";
  if (command === "mode" || command === "config" || command === "settings") return "mode";
  if (command === "sleep" || command === "system") return "sleep";
  if (command === "display" || command === "screen") return "display";
  if (command === "stop" || command === "off") return "stop";
  return "unknown";
}

export function commandCompletions(prefix: string) {
  const normalized = prefix.trimStart().toLowerCase();
  if (/\s/.test(normalized)) return null;

  const matches = COMMAND_COMPLETIONS.filter((completion) => completion.value.startsWith(normalized));
  return matches.length > 0 ? matches : null;
}

function buildCommandGuide() {
  return [
    "pi-caffeinate commands:",
    "/caffeinate — open keep-awake controls",
    "/caffeinate display — keep the system and display awake",
    "/caffeinate sleep — keep the system awake while allowing display sleep",
    "/caffeinate status — show current mode, settings, and inhibitor state",
    "/caffeinate mode — choose a keep-awake mode",
    "/caffeinate stop — release the active inhibitor until the next agent run",
  ].join("\n");
}

async function startInhibitor(ctx: ExtensionContext, sessionGeneration: number, options: { notify?: boolean } = {}) {
  if (state.disabled || hasActiveInhibitor() || state.inhibitorStarting) {
    updateStatus(ctx);
    return;
  }

  const token = ++inhibitSequence;
  const command = getInhibitorCommand(state.mode);
  const wantsDbus =
    !command?.custom &&
    state.mode === "display" &&
    process.platform === "linux" &&
    (command === undefined || command.addDbusIdleInhibit === true);
  if (!command && !wantsDbus) {
    state.available = false;
    state.lastError = `No supported sleep inhibitor found for ${process.platform}.`;
    ctx.ui.notify(state.lastError, "warning");
    updateStatus(ctx);
    return;
  }

  state.inhibitorStarting = true;
  state.inhibitWarning = undefined;
  let child: ChildProcess | undefined;
  let childError =
    !command && wantsDbus
      ? "No supported system sleep inhibitor is available; direct system suspend may remain possible."
      : undefined;
  let assembling = true;
  const handleChildFailure = (message: string) => {
    if (!child || token !== inhibitSequence || state.process !== child) return;
    state.process = undefined;
    state.command = undefined;
    if (assembling) {
      childError = message;
      return;
    }
    applyChildFailure(message);
  };

  if (command) {
    try {
      child = startInhibitorProcess(
        command,
        (error) => handleChildFailure(`${command.description} failed: ${error.message}`),
        (exit) => handleChildFailure(`${command.description} exited unexpectedly (${exit}).`),
      );
      state.process = child;
      state.command = command;
      state.startedAt = Date.now();
    } catch (error) {
      childError = `${command.description}: ${formatError(error)}`;
    }
  }

  let dbus: DbusScreenSaverClient | undefined;
  let dbusError: string | undefined;
  if (wantsDbus) {
    const pending: PendingDbusStart = { token, controller: new AbortController() };
    state.pendingDbus = pending;
    try {
      const client = await dbusFactory();
      if (!pendingStartIsCurrent(pending, sessionGeneration)) {
        await client.close().catch(() => undefined);
        await cancelPendingStart(token, child, command);
        return;
      }
      pending.client = client;
      await client.inhibit(INHIBIT_REASON, pending.controller.signal);
      if (!pendingStartIsCurrent(pending, sessionGeneration)) {
        await cancelPendingStart(token, child, command);
        return;
      }
      pending.client = undefined;
      state.pendingDbus = undefined;
      dbus = client;
    } catch (error) {
      const stale = !pendingStartIsCurrent(pending, sessionGeneration) || pending.controller.signal.aborted;
      const pendingClient = takePendingDbusClient(pending);
      await pendingClient?.close().catch(() => undefined);
      if (stale) {
        await cancelPendingStart(token, child, command);
        return;
      }
      dbusError = `D-Bus idle inhibit (${SCREENSAVER_BUS_NAME}): ${formatError(error)}`;
    }
  }

  assembling = false;
  if (startIsStale(token, sessionGeneration)) {
    await cancelPendingStart(token, child, command);
    await dbus?.close().catch(() => undefined);
    return;
  }

  state.inhibitorStarting = false;
  state.dbus = dbus;
  if (dbus) {
    dbus.setFailureHandler((error) => applyDbusFailure(token, dbus, error));
    if (state.dbus !== dbus) return;
  }
  const failures = [childError, dbusError].filter((failure): failure is string => Boolean(failure));
  if (!hasActiveInhibitor()) {
    state.startedAt = undefined;
    state.command = undefined;
    state.available = false;
    state.lastError = failures.join("; ") || `No supported sleep inhibitor found for ${process.platform}.`;
    ctx.ui.notify(state.lastError, "warning");
    updateStatus(ctx);
    return;
  }

  state.startedAt ??= Date.now();
  state.available = true;
  state.lastError = undefined;
  state.inhibitWarning = failures.length > 0 ? failures.join("; ") : undefined;
  if (state.inhibitWarning) {
    ctx.ui.notify(`pi-caffeinate is partially active: ${state.inhibitWarning}`, "warning");
  } else if (options.notify !== false) {
    ctx.ui.notify(`Keeping computer awake (${statusModeLabel()}).`, "info");
  }
  updateStatus(ctx);
}

async function stopInhibitor(ctx: ExtensionContext, reason: string, options: { notify?: boolean } = {}) {
  inhibitSequence += 1;
  const child = state.process;
  const dbus = state.dbus;
  const dbusCleanup = state.dbusCleanup;
  const pending = state.pendingDbus;
  const command = state.command;
  const wasStarting = state.inhibitorStarting;
  state.process = undefined;
  state.dbus = undefined;
  state.dbusCleanup = undefined;
  state.pendingDbus = undefined;
  state.command = undefined;
  state.startedAt = undefined;
  state.inhibitWarning = undefined;
  state.inhibitorStarting = false;
  dbus?.setFailureHandler(undefined);
  pending?.controller.abort(new DOMException(`Caffeinate stopped: ${reason}`, "AbortError"));
  const pendingClient = pending ? takePendingDbusClient(pending) : undefined;
  if (child) stopInhibitorProcess(child, command);
  if (!child && !dbus && !pendingClient && !wasStarting) {
    await dbusCleanup;
    return;
  }
  if (options.notify !== false) ctx.ui.notify(`Released pi-caffeinate (${reason}).`, "info");
  await Promise.all([dbusCleanup, pendingClient?.close().catch(() => undefined)]);
  if (!dbus) return;
  try {
    await dbus.uninhibit();
  } catch {
    // Closing the session-bus connection also releases its inhibition cookie.
  }
  await dbus.close().catch(() => undefined);
}

function applyChildFailure(message: string) {
  if (state.dbus) {
    state.available = true;
    state.lastError = undefined;
    state.inhibitWarning = message;
  } else {
    state.startedAt = undefined;
    state.available = false;
    state.lastError = message;
    state.inhibitWarning = undefined;
  }
  const ctx = currentSessionContext();
  if (!ctx) return;
  ctx.ui.notify(message, "warning");
  updateStatus(ctx);
}

function applyDbusFailure(token: number, client: DbusScreenSaverClient, error: Error) {
  if (token !== inhibitSequence || state.dbus !== client) return;
  client.setFailureHandler(undefined);
  state.dbus = undefined;
  const message = `D-Bus idle inhibit (${SCREENSAVER_BUS_NAME}) failed: ${formatError(error)}`;
  const notification = state.process ? `pi-caffeinate is partially active: ${message}` : message;
  if (state.process) {
    state.available = true;
    state.lastError = undefined;
    state.inhibitWarning = message;
  } else {
    state.startedAt = undefined;
    state.command = undefined;
    state.available = false;
    state.lastError = [state.inhibitWarning, message].filter(Boolean).join("; ");
    state.inhibitWarning = undefined;
  }
  const cleanup = client.close().catch(() => undefined);
  state.dbusCleanup = cleanup;
  void cleanup.then(() => {
    if (state.dbusCleanup === cleanup) state.dbusCleanup = undefined;
  });
  const ctx = currentSessionContext();
  if (!ctx) return;
  ctx.ui.notify(notification, "warning");
  updateStatus(ctx);
}

function currentSessionContext() {
  const session = state.currentSession;
  return session?.generation === state.sessionGeneration ? session.ctx : undefined;
}

function hasActiveInhibitor() {
  return Boolean(state.process || state.dbus);
}

function startIsStale(token: number, sessionGeneration: number) {
  return token !== inhibitSequence || sessionGeneration !== state.sessionGeneration;
}

function pendingStartIsCurrent(pending: PendingDbusStart, sessionGeneration: number) {
  return (
    state.pendingDbus === pending &&
    !pending.controller.signal.aborted &&
    !startIsStale(pending.token, sessionGeneration)
  );
}

function takePendingDbusClient(pending: PendingDbusStart) {
  if (state.pendingDbus === pending) state.pendingDbus = undefined;
  const client = pending.client;
  pending.client = undefined;
  return client;
}

async function cancelPendingStart(
  token: number,
  child: ChildProcess | undefined,
  command: InhibitorCommand | undefined,
) {
  if (token !== inhibitSequence) return;
  inhibitSequence += 1;
  state.inhibitorStarting = false;
  const pending = state.pendingDbus?.token === token ? state.pendingDbus : undefined;
  state.pendingDbus = undefined;
  pending?.controller.abort(new DOMException("Caffeinate start cancelled", "AbortError"));
  const pendingClient = pending ? takePendingDbusClient(pending) : undefined;
  if (child && state.process === child) {
    state.process = undefined;
    state.command = undefined;
    state.startedAt = undefined;
    stopInhibitorProcess(child, command);
  }
  await pendingClient?.close().catch(() => undefined);
}

function updateStatus(ctx: ExtensionContext) {
  if (state.disabled || state.quiet) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  if (hasActiveInhibitor()) {
    ctx.ui.setStatus(STATUS_KEY, withDeprecatedIcon(statusModeLabel()));
    return;
  }

  if (!state.available) {
    ctx.ui.setStatus(STATUS_KEY, withDeprecatedIcon("unavailable"));
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, undefined);
}

function describeState() {
  const customCommand = hasCustomCommand();
  const lines = [
    `Mode: ${formatMode(state.mode)}${customCommand ? " (overridden by custom command)" : ""}`,
    `Quiet mode: ${state.quiet ? "enabled" : "disabled"}`,
    `Settings: ${settingsFilePath()}`,
  ];

  if (customCommand) lines.push("Custom command: PI_CAFFEINATE_COMMAND overrides the saved mode.");
  if (state.settingsNotice) lines.push(`Settings note: ${state.settingsNotice}`);
  if (state.settingsError) lines.push(`Settings warning: ${state.settingsError}`);
  if (state.disabled) {
    lines.unshift("pi-caffeinate is disabled by PI_CAFFEINATE_DISABLED.");
    return lines.join("\n");
  }

  if (hasActiveInhibitor()) {
    const seconds = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
    const activeParts: string[] = [];
    if (state.dbus) activeParts.push(`D-Bus idle inhibit (${SCREENSAVER_BUS_NAME})`);
    if (state.process && state.command) activeParts.push(state.command.description);
    lines.unshift(`pi-caffeinate is active using ${activeParts.join(" + ") || "an inhibitor"} for ${seconds}s.`);
    if (state.inhibitWarning) lines.push(`Inhibitor warning: ${state.inhibitWarning}`);
    return lines.join("\n");
  }

  if (!state.available) {
    lines.unshift(`pi-caffeinate is unavailable: ${state.lastError ?? "unknown reason"}`);
    return lines.join("\n");
  }

  lines.unshift("pi-caffeinate is idle and will keep the computer awake during the next agent run.");
  return lines.join("\n");
}

function statusLevel() {
  return state.available && !state.settingsError && !state.inhibitWarning ? "info" : "warning";
}

function statusModeLabel() {
  if (state.command?.custom) return "custom";
  return formatMode(state.mode);
}

async function ensureSettingsLoaded(ctx: ExtensionContext, generation: number) {
  if (state.disabled || state.settingsLoaded) return;
  await loadSettingsIntoState(ctx, generation);
}

async function loadSettingsIntoState(ctx: ExtensionContext, generation: number) {
  if (state.disabled) {
    state.settingsLoaded = true;
    state.settingsError = undefined;
    state.quiet = false;
    return;
  }

  const settings = await loadSettings();
  if (generation !== state.sessionGeneration) return;
  state.settingsLoaded = true;
  state.settingsError = undefined;
  if (settings.notice) {
    state.settingsNotice = settings.notice;
    ctx.ui.notify(settings.notice, "warning");
  }

  if (settings.kind === "loaded") {
    state.mode = settings.settings.mode;
    state.quiet = settings.settings.quiet;
    return;
  }

  state.mode = DEFAULT_MODE;
  state.quiet = false;
  if (settings.kind === "invalid") {
    state.settingsError = settings.reason;
    ctx.ui.notify(
      `pi-caffeinate settings ignored: ${settings.reason}; using ${formatMode(DEFAULT_MODE)} mode.`,
      "warning",
    );
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isDisabled() {
  const value = process.env.PI_CAFFEINATE_DISABLED?.trim().toLowerCase();
  return value ? DISABLED_VALUES.has(value) : false;
}

function hasCustomCommand() {
  return Boolean(process.env.PI_CAFFEINATE_COMMAND?.trim());
}

function withDeprecatedIcon(text: string) {
  const icon = process.env.PI_CAFFEINATE_ICON?.trim();
  return icon ? `${icon} ${text}` : text;
}

function warnDeprecatedIcon(ctx: ExtensionContext) {
  if (state.iconWarningShown || !process.env.PI_CAFFEINATE_ICON?.trim()) return;
  state.iconWarningShown = true;
  ctx.ui.notify(
    "PI_CAFFEINATE_ICON is deprecated but still works for now. If you use @narumitw/pi-statusline, move it to pi-statusline.json (extensionStatusIcons.caffeinate).",
    "warning",
  );
}

export {
  formatMode,
  getInhibitorCommand,
  splitCommand,
  windowsInhibitorScript,
} from "./inhibitors.js";
export { normalizeCaffeinateSettings } from "./settings.js";
