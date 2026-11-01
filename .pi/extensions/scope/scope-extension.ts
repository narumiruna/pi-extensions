import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { ANCHOR_TYPE, createScopeNotice, reconcileScopeContext } from "./contracts.ts";
import { displayError, displayPath } from "./display.ts";
import type { ScopeMenuOptions, ScopeView } from "./menu.ts";
import { assertScopeTarget, resolveScopeTarget, type ScopeTarget } from "./paths.ts";
import { assertUsableLoadout, decideTool } from "./policy.ts";
import { ScopeSettingsStore } from "./settings.ts";
import { createSnapshot, restoreScope, type ScopeSnapshot, type ScopeState, STATE_TYPE, sameScope } from "./state.ts";

type ShowMenu = (ctx: ExtensionCommandContext, options: ScopeMenuOptions) => Promise<void>;
interface Flow {
  controller: AbortController;
  revision: number;
  promise?: Promise<void>;
}
interface Owner {
  key: object;
  controller: AbortController;
  settings: ScopeSettingsStore;
  scope: ScopeState;
  revision: number;
  checks: Set<Promise<void>>;
  flow?: Flow;
  widgetUI?: ExtensionContext["ui"];
}

const uninitialized = (): ScopeState => ({ state: "blocked", error: "Scope is not initialized; edits remain blocked" });
const showMenu: ShowMenu = async (ctx, options) => {
  const { showScopeMenu } = await import("./menu.ts");
  options.signal.throwIfAborted();
  if (options.isCurrent()) await showScopeMenu(ctx, options);
};

export function createScopeExtension(show: ShowMenu = showMenu) {
  return (pi: ExtensionAPI) => {
    const owners = new Map<object, Owner>();
    const starts = new WeakMap<object, object>();

    function current(owner: Owner, _ctx?: ExtensionContext): boolean {
      // Do not touch a captured context after its session has been replaced.
      return !owner.controller.signal.aborted && owners.get(owner.key) === owner;
    }
    function check(owner: Owner, ctx: ExtensionContext, flow?: Flow): void {
      owner.controller.signal.throwIfAborted();
      flow?.controller.signal.throwIfAborted();
      if (!current(owner, ctx) || (flow && (owner.flow !== flow || owner.revision !== flow.revision))) {
        throw new DOMException("Scope session or selection changed", "AbortError");
      }
      ctx.signal?.throwIfAborted();
    }
    function mutationCheck(owner: Owner, ctx: ExtensionContext, flow?: Flow): void {
      check(owner, ctx, flow);
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        throw new Error("Stop the current run and clear pending messages before changing Scope");
      }
    }
    function view(owner: Owner, ctx: ExtensionContext): ScopeView {
      return {
        state: owner.scope.state,
        cwd: ctx.cwd,
        targets: (owner.scope.snapshot?.targets ?? []).map((target) => ({ ...target })),
        ...(owner.scope.error ? { error: owner.scope.error } : {}),
      };
    }
    function clearWidget(owner: Owner): void {
      const ui = owner.widgetUI;
      owner.widgetUI = undefined;
      ui?.setWidget("scope", undefined);
    }
    function updateWidget(owner: Owner, ctx: ExtensionContext): void {
      if (!current(owner, ctx)) return;
      if (owner.scope.state === "inactive" || ctx.mode !== "tui" || !ctx.hasUI) {
        clearWidget(owner);
        return;
      }
      owner.widgetUI = ctx.ui;
      ctx.ui.setWidget(
        "scope",
        (_tui, theme) =>
          new EditorStatusWidget({
            theme,
            renderBody: () => {
              const targets = owner.scope.snapshot?.targets ?? [];
              return [
                theme.fg(
                  owner.scope.state === "blocked" ? "error" : "accent",
                  owner.scope.state === "blocked"
                    ? "Scope unavailable · edits blocked"
                    : `Editing limited to ${targets.length} file${targets.length === 1 ? "" : "s"}`,
                ),
                theme.fg(
                  "dim",
                  `${targets
                    .slice(0, 2)
                    .map((target) => displayPath(target.path))
                    .join(" · ")}${targets.length > 2 ? " · …" : ""}${targets.length ? " · " : ""}/scope off`,
                ),
              ];
            },
          }),
      );
    }
    function notify(ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error" = "info"): void {
      if (ctx.hasUI) ctx.ui.notify(displayError(message).slice(0, 4_000), kind);
    }
    async function release(owner: Owner): Promise<void> {
      owner.controller.abort(new DOMException("Scope session ended", "AbortError"));
      clearWidget(owner);
      const settled = await Promise.allSettled([owner.flow?.promise, owner.settings.flush(), ...owner.checks]);
      if (settled[1].status === "rejected") throw settled[1].reason;
    }
    async function initialize(ctx: ExtensionContext): Promise<void> {
      const key = ctx.sessionManager;
      const token = {};
      starts.set(key, token);
      const previous = owners.get(key);
      const owner: Owner = {
        key,
        controller: new AbortController(),
        settings: new ScopeSettingsStore(join(getAgentDir(), "pi-scope.json")),
        scope: uninitialized(),
        revision: 0,
        checks: new Set(),
      };
      owners.set(key, owner);
      if (previous) await release(previous);
      if (starts.get(key) !== token || !current(owner, ctx)) return;
      try {
        owner.scope = restoreScope(ctx.sessionManager.getBranch(), ctx.cwd);
      } catch {
        owner.scope = {
          state: "blocked",
          error: "Scope restoration failed; edits remain blocked. Use /scope to repair or /scope off to exit.",
        };
      }
      if (owner.scope.state === "active") {
        try {
          assertUsableLoadout(pi);
        } catch (error) {
          owner.scope = { ...owner.scope, state: "blocked", error: displayError(error) };
        }
      }
      try {
        await owner.settings.load();
      } catch (error) {
        if (current(owner, ctx)) notify(ctx, `Scope settings were not loaded: ${displayError(error)}`, "warning");
      }
      if (starts.get(key) !== token || !current(owner, ctx)) return;
      updateWidget(owner, ctx);
      if (owner.scope.state === "blocked") notify(ctx, owner.scope.error ?? "Scope restoration failed", "error");
    }

    function publish(owner: Owner, ctx: ExtensionContext): void {
      const notice = createScopeNotice(owner.scope);
      if (!notice) return;
      try {
        // sendMessage has no persistence acknowledgement. Context verifies retention and stores
        // a fixed restoration anchor if delivery is deferred or the handoff was compacted away.
        pi.sendMessage(notice, { triggerTurn: false });
      } catch (error) {
        notify(ctx, `Scope is applied, but its model notice needs recovery: ${displayError(error)}`, "warning");
      }
    }
    function commit(
      owner: Owner,
      ctx: ExtensionContext,
      snapshot: ScopeSnapshot,
      flow?: Flow,
      signal?: AbortSignal,
    ): void {
      signal?.throwIfAborted();
      mutationCheck(owner, ctx, flow);
      owner.scope = { state: "blocked", error: "Scope update is incomplete; edits remain blocked" };
      owner.revision += 1;
      if (flow) flow.revision = owner.revision;
      try {
        pi.appendEntry(STATE_TYPE, snapshot);
        check(owner, ctx, flow);
        const restored = restoreScope(ctx.sessionManager.getBranch(), ctx.cwd);
        if (restored.state === "blocked" || !sameScope(restored.snapshot, snapshot) || !restored.entryId) {
          throw new Error("Scope state was not retained by the session");
        }
        owner.scope = restored;
      } catch (error) {
        // SessionManager can update memory before a disk failure. Do not claim rollback or
        // silently fall back to unrestricted editing when publication is uncertain.
        if (current(owner, ctx)) {
          owner.scope = {
            state: "blocked",
            error: `Scope state could not be saved; edits remain blocked. Repair with /scope or /scope off. ${displayError(error)}`,
          };
          updateWidget(owner, ctx);
        }
        throw error;
      }
      updateWidget(owner, ctx);
      publish(owner, ctx);
    }
    async function apply(
      owner: Owner,
      ctx: ExtensionContext,
      targets: readonly ScopeTarget[],
      flow: Flow,
      newFile = false,
      operation?: AbortSignal,
    ): Promise<void> {
      const signal = AbortSignal.any([
        owner.controller.signal,
        flow.controller.signal,
        ...(operation ? [operation] : []),
      ]);
      signal.throwIfAborted();
      mutationCheck(owner, ctx, flow);
      const proposed = createSnapshot(resolve(ctx.cwd), targets);
      // Newly resolved existing files must still exist at commit. Keep the
      // requirement across canonical alias deduplication; live reserved paths
      // without resolution metadata may still be missing.
      const existing = new Set(
        targets.filter((target) => "exists" in target && target.exists === true).map((target) => target.canonical),
      );
      if (newFile && proposed.targets?.length !== 1) throw new Error("New file requires exactly one target");
      assertUsableLoadout(pi);
      const checked: ScopeTarget[] = [];
      for (const target of proposed.targets ?? []) {
        const candidate = await resolveScopeTarget(
          pathToFileURL(target.path).href,
          ctx.cwd,
          newFile ? "new" : existing.has(target.canonical) ? "existing" : "either",
          signal,
        );
        signal.throwIfAborted();
        mutationCheck(owner, ctx, flow);
        if (candidate.canonical !== target.canonical)
          throw new Error(`Scope target changed: ${displayPath(target.path)}; select it again`);
        checked.push({ path: candidate.path, canonical: candidate.canonical });
      }
      assertUsableLoadout(pi);
      const snapshot = createSnapshot(resolve(ctx.cwd), checked);
      createScopeNotice({ state: "active", snapshot, entryId: "preview" });
      if (owner.scope.state !== "blocked" && sameScope(owner.scope.snapshot, snapshot)) {
        notify(ctx, "Scope unchanged");
        return;
      }
      commit(owner, ctx, snapshot, flow, signal);
      notify(ctx, `Editing limited to ${checked.length} file${checked.length === 1 ? "" : "s"}`);
    }
    function off(owner: Owner, ctx: ExtensionContext, flow?: Flow): void {
      mutationCheck(owner, ctx, flow);
      if (owner.scope.state === "inactive") {
        notify(ctx, "Scope is already inactive");
        return;
      }
      commit(owner, ctx, createSnapshot(resolve(ctx.cwd), null), flow);
      notify(ctx, "Scope restriction ended");
    }

    pi.on("session_start", (_event, ctx) => initialize(ctx));
    pi.on("session_tree", (_event, ctx) => initialize(ctx));
    pi.on("session_shutdown", async (_event, ctx) => {
      const key = ctx.sessionManager;
      starts.delete(key);
      const owner = owners.get(key);
      if (!owner) return;
      try {
        await release(owner);
      } finally {
        if (owners.get(key) === owner) owners.delete(key);
      }
    });

    pi.on("tool_call", async (event, ctx) => {
      const owner = owners.get(ctx.sessionManager);
      const scope = owner && current(owner) ? owner.scope : uninitialized();
      if (scope.state === "inactive") return;
      const decision = decideTool(event.toolName, pi.getAllTools(), scope);
      if (decision.kind === "pass") return;
      if (decision.kind === "block") return { block: true, reason: displayError(decision.reason).slice(0, 4_000) };
      const revision = owner?.revision;
      let work: Promise<void> | undefined;
      try {
        const path =
          event.input && typeof event.input === "object" && "path" in event.input ? event.input.path : undefined;
        if (!owner || !scope.snapshot?.targets || typeof path !== "string")
          throw new Error("Invalid Scope write/edit call");
        check(owner, ctx);
        const signal = ctx.signal ? AbortSignal.any([owner.controller.signal, ctx.signal]) : owner.controller.signal;
        work = assertScopeTarget(path, ctx.cwd, scope.snapshot.targets, signal);
        owner.checks.add(work);
        await work;
        check(owner, ctx);
        if (owner.revision !== revision || owner.scope !== scope)
          throw new Error("Scope changed while checking this call");
      } catch (error) {
        return { block: true, reason: `Scope blocked this edit: ${displayError(error).slice(0, 4_000)}` };
      } finally {
        if (work) owner?.checks.delete(work);
      }
    });

    // Legacy context folds native prompt/tool deltas into the leading system message
    // after an insertion. Keep the full transcript so anchored recovery stays additive.
    pi.on("context_with_system", (event, ctx) => {
      const owner = owners.get(ctx.sessionManager);
      if (!owner || !current(owner, ctx) || ctx.signal?.aborted) return;
      try {
        if (owner.scope.state === "active") {
          try {
            assertUsableLoadout(pi);
          } catch (error) {
            owner.scope = { ...owner.scope, state: "blocked", error: displayError(error) };
            owner.revision += 1;
            owner.flow?.controller.abort(new DOMException("Scope tool configuration changed", "AbortError"));
            updateWidget(owner, ctx);
            notify(ctx, owner.scope.error ?? "Scope tool configuration is unsupported", "error");
          }
        }
        const result = reconcileScopeContext(event.messages, ctx.sessionManager.getBranch(), owner.scope);
        if (result.anchor) {
          pi.appendEntry(ANCHOR_TYPE, result.anchor);
          check(owner, ctx);
        }
        return { messages: result.messages };
      } catch (error) {
        if (!current(owner) || ctx.signal?.aborted) return;
        owner.scope = {
          ...owner.scope,
          state: "blocked",
          error: "Scope context could not be restored; edits remain blocked. Repair with /scope or /scope off.",
        };
        owner.revision += 1;
        owner.flow?.controller.abort(new DOMException("Scope context restoration failed", "AbortError"));
        updateWidget(owner, ctx);
        throw error;
      }
    });

    pi.registerCommand("scope", {
      description: "Temporarily restrict editing to selected files",
      getArgumentCompletions: (prefix) =>
        "off".startsWith(prefix) ? [{ value: "off", label: "off", description: "End the editing restriction" }] : [],
      handler: async (args, ctx) => {
        const route = args.trim();
        if (route !== "" && route !== "off") throw new Error("Usage: /scope or /scope off");
        if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("/scope requires Pi TUI mode");
        const owner = owners.get(ctx.sessionManager);
        if (!owner) throw new Error("Scope is not initialized; reload the session first");
        mutationCheck(owner, ctx);
        if (owner.flow) throw new Error("A Scope menu is already open; close it before issuing another Scope command");
        if (route === "off") return off(owner, ctx);
        const flow: Flow = { controller: new AbortController(), revision: owner.revision };
        owner.flow = flow;
        const options: ScopeMenuOptions = {
          signal: AbortSignal.any([owner.controller.signal, flow.controller.signal]),
          isCurrent: () =>
            current(owner, ctx) &&
            !flow.controller.signal.aborted &&
            owner.flow === flow &&
            owner.revision === flow.revision,
          getView: () => {
            check(owner, ctx, flow);
            return view(owner, ctx);
          },
          getSettings: () => {
            check(owner, ctx, flow);
            return { ...owner.settings.current };
          },
          saveShowHiddenFiles: async (value) => {
            check(owner, ctx, flow);
            await owner.settings.saveShowHiddenFiles(value);
            check(owner, ctx, flow);
          },
          apply: (targets, newFile, signal) => {
            const work = apply(owner, ctx, targets, flow, newFile, signal);
            owner.checks.add(work);
            void work.then(
              () => owner.checks.delete(work),
              () => owner.checks.delete(work),
            );
            return work;
          },
          off: async () => off(owner, ctx, flow),
        };
        flow.promise = Promise.resolve().then(() => show(ctx, options));
        try {
          await flow.promise;
          check(owner, ctx, flow);
        } catch (error) {
          if (current(owner, ctx)) throw error;
        } finally {
          flow.controller.abort(new DOMException("Scope menu closed", "AbortError"));
          if (owner.flow === flow) owner.flow = undefined;
        }
      },
    });
  };
}

export default createScopeExtension();
