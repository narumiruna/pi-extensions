import { copyToClipboard, type ExtensionCommandContext, type Skill } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { defineMenu, runMenu, runTask } from "@narumitw/pi-tui-kit";
import { sanitizeTerminalText as safe } from "@narumitw/pi-tui-kit/terminal-text";
import type { Route } from "./command.ts";
import { prepareOperation, scanInventory } from "./filesystem.ts";
import { discoverRepository, downloadBundles, parseRepository } from "./github.ts";
import { type InvocationSnapshot, readInvocation, updateInvocation } from "./invocation.ts";
import { applyRegistration, customLocation, loadLocations, previewRegistration } from "./locations.ts";
import { getManagedSkills, type ManagedSkill } from "./managed-skills.ts";
import type {
  Environment,
  Guard,
  Inventory,
  Location,
  OperationRequest,
  OperationResult,
  PreparedBatch,
  RegistrationPlan,
  RegistrationScope,
  RepositorySnapshot,
} from "./types.ts";

export const HELP = [
  "/skills opens this manager. /skills add [owner/repo], remove, and move are interactive shortcuts.",
  "Public GitHub repositories only. Each add uses one fixed commit below skills/.",
  "Review unfamiliar SKILL.md files and supporting programs before installation. Installation does not run them.",
  "Complete directories are copied. References outside each selected bundle are not copied or rewritten.",
  "Project means the current Pi working directory. Shared locations can also be read by compatible agents.",
  "Existing destinations are skipped; duplicate names can still conflict under Pi's native discovery rules.",
  "Manage skills combines detected bundles and native loaded skills. Select a skill for Model invocation, Move, Remove, or Copy directory path.",
  "Only native loaded skills enable Model invocation; only scanned bundles can enable Move/Remove. Protected bundles remain protected. Invocation changes require a target review.",
  "Invocation settings save immediately to the source file, including linked targets. User/shared edits affect other projects; package updates can replace edits. Escape does not undo saves.",
  "Single-skill Move and Remove reuse batch confirmation. Copy directory path sends the exact raw path to the clipboard in TUI only.",
  "Custom paths can be registered in native project/user skills settings, or copied without registration.",
  "Bundle operations change nothing before confirmation. Invocation toggles save immediately; cancellation does not undo completed saves. Confirmed batches can finish partially.",
  "Do not run concurrent mutations from separate Pi processes. External filesystem edits are not locked.",
  "Reload is explicit. Removing a skill does not remove instructions already in conversation history.",
];

export const defaultServices = {
  loadLocations,
  scanInventory,
  discoverRepository,
  downloadBundles,
  prepareOperation,
  customLocation,
  previewRegistration,
  applyRegistration,
  copyToClipboard,
  readInvocation,
  updateInvocation,
};
export type Services = typeof defaultServices;

type Screen =
  | "main"
  | "source"
  | "fetch"
  | "select"
  | "preview"
  | "destination"
  | "custom"
  | "registration"
  | "ready"
  | "review"
  | "manage"
  | "skill-actions"
  | "invocation-review"
  | "invocation-setting"
  | "help"
  | "inventory-path"
  | "inventory-ready";
type Action =
  | "begin"
  | "source"
  | "discover"
  | "toggle"
  | "continue"
  | "target"
  | "custom"
  | "registration"
  | "prepare"
  | "confirm"
  | "inventory-path"
  | "scan"
  | "manage"
  | "manage-skill"
  | "move-one"
  | "remove-one"
  | "copy-directory"
  | "manage-scan"
  | "select-invocation"
  | "review-invocation"
  | "save-invocation"
  | "reload"
  | "back";

interface State {
  mode: OperationRequest["kind"];
  source: string;
  repository?: RepositorySnapshot;
  selected: Set<string>;
  locations: Location[];
  inventory: Inventory;
  warnings: string[];
  target?: Location;
  registration?: RegistrationPlan;
  registrationScope: RegistrationScope;
  batch?: PreparedBatch;
  confirmed: boolean;
  extra?: Location;
  afterScan: "manage" | "select";
  managedId?: string;
  copyMessage?: string;
  loadedSkills: Skill[];
  invocation?: InvocationSnapshot;
  invocationChanged: boolean;
  invocationValues: Map<string, boolean>;
  invocationController?: AbortController;
  invocationReviewed?: boolean;
  reload: boolean;
}

function actionGuard(owner: Guard, signal: AbortSignal): Guard {
  return {
    signal: AbortSignal.any([owner.signal, signal]),
    check() {
      owner.check();
      signal.throwIfAborted();
    },
    isProjectTrusted: owner.isProjectTrusted,
  };
}

function invocationContext(ctx: ExtensionCommandContext, state: State, owner: Guard): ExtensionCommandContext {
  if (ctx.mode !== "tui") return ctx;
  const custom: typeof ctx.ui.custom = (factory, options) =>
    ctx.ui.custom(async (tui, theme, keybindings, done) => {
      const controller = new AbortController();
      state.invocationController = controller;
      let component: Awaited<ReturnType<typeof factory>> | undefined;
      try {
        component = await factory(tui, theme, keybindings, done);
        owner.check();
      } catch (error) {
        controller.abort();
        component?.dispose?.();
        throw error;
      }
      const input = component.handleInput?.bind(component);
      const dispose = component.dispose?.bind(component);
      let disposed = false;
      component.handleInput = (data) => {
        if (disposed) return;
        // A save can be queued before its handler starts. Cancel the screen's
        // settings scope first, then forward the standard key unchanged. Other
        // actions do not use this extra signal; Kit still owns Back/Close/drain.
        if (matchesKey(data, Key.ctrl("c")) || keybindings.matches(data, "tui.select.cancel"))
          controller.abort(new DOMException("Invocation setting cancelled", "AbortError"));
        input?.(data);
      };
      component.dispose = () => {
        if (disposed) return;
        disposed = true;
        controller.abort(new DOMException("Invocation screen disposed", "AbortError"));
        dispose?.();
      };
      return component;
    }, options);
  return { ...ctx, ui: { ...ctx.ui, custom } };
}

function invocationMode(enabled: boolean): string {
  return enabled ? "Automatic" : "Manual only";
}

function invocationNeedsReload(state: State): boolean {
  return (
    state.invocationChanged ||
    state.loadedSkills.some((skill) => {
      const saved = state.invocationValues.get(skill.filePath);
      return saved !== undefined && saved !== !skill.disableModelInvocation;
    })
  );
}

function managedSkills(state: State) {
  return getManagedSkills(state.inventory.skills, state.loadedSkills).sort((left, right) =>
    safe(left.name).localeCompare(safe(right.name)),
  );
}

function managedScope(skill: ManagedSkill): string {
  return safe(
    skill.local?.location.label ??
      (skill.loaded?.sourceInfo.scope === "user"
        ? "User"
        : skill.loaded?.sourceInfo.scope === "project"
          ? "Project"
          : "Unknown"),
  );
}

function managedItems(state: State, rpc: boolean) {
  return managedSkills(state).map((skill) => {
    const loaded = skill.loaded;
    const active = loaded ? !loaded.disableModelInvocation : undefined;
    const saved = loaded ? state.invocationValues.get(loaded.filePath) : undefined;
    const mode = active === undefined ? "Not loaded" : invocationMode(saved ?? active);
    // SelectList falls back to its raw value when the normalized label is empty.
    const name = safe(skill.name).trim() || "Unnamed skill";
    const pending = saved !== undefined && saved !== active;
    const scope = managedScope(skill);
    return {
      id: skill.id,
      label: rpc ? `${name} · ${mode}${pending ? " (reload pending)" : ""} · ${scope} · ${safe(skill.filePath)}` : name,
      description: `${mode} · ${scope}${pending ? " · Reload pending" : ""}`,
      details: [
        `Skill: ${name}`,
        `File: ${safe(skill.filePath)}`,
        `Source: ${scope}${loaded ? ` · ${safe(loaded.sourceInfo.source)}` : ""}`,
        active === undefined
          ? "Not currently loaded by Pi."
          : `Active: ${invocationMode(active)}${saved !== undefined ? ` · Saved: ${mode}${pending ? " (reload pending)" : ""}` : ""}`,
        ...(skill.local?.warnings.map(safe) ?? []),
        ...(skill.local?.readOnlyReason ? [`Bundle actions: ${safe(skill.local.readOnlyReason)}`] : []),
      ],
      searchText: `${safe(skill.name)} ${safe(skill.description)} ${safe(skill.filePath)} ${safe(loaded?.description ?? "")} ${safe(loaded?.sourceInfo.source ?? "")}`,
    };
  });
}

function inventorySkills(state: State) {
  return getManagedSkills(state.inventory.skills, []).flatMap((skill) => (skill.local ? [skill.local] : []));
}

function selectedLocals(state: State) {
  return inventorySkills(state).filter((skill) => state.selected.has(skill.id) && !skill.readOnlyReason);
}

function selectionItems(state: State, rpc: boolean) {
  if (state.mode === "add") {
    return (state.repository?.skills ?? []).map((skill) => ({
      id: skill.id,
      label: rpc ? `${safe(skill.name)} · ${safe(skill.directory)}` : skill.name,
      description: `${skill.directory} — ${skill.description}`,
      searchText: `${skill.directory} ${skill.description}`,
      selected: state.selected.has(skill.id),
      disabled: Boolean(skill.disabledReason),
      disabledReason: skill.disabledReason,
    }));
  }
  return inventorySkills(state).map((skill) => ({
    id: skill.id,
    label: `${safe(skill.name)} · ${safe(skill.location.label)}${rpc ? ` · ${safe(skill.path)}` : ""}`,
    description: `${skill.path}${skill.warnings.length ? ` — ${skill.warnings.join("; ")}` : ""}`,
    searchText: `${skill.path} ${skill.description}`,
    selected: state.selected.has(skill.id),
    disabled: Boolean(skill.readOnlyReason),
    disabledReason: skill.readOnlyReason,
  }));
}

function previewItems(state: State, rpc: boolean) {
  if (state.mode === "add") {
    return (state.repository?.skills ?? [])
      .filter((skill) => state.selected.has(skill.id))
      .map((skill) => ({
        id: skill.id,
        label: rpc ? `${safe(skill.name)} · ${safe(skill.directory)}` : skill.name,
        description: skill.directory,
        statusText: skill.warnings.join("; "),
        detailDocument: { content: skill.content, format: { kind: "text" as const } },
      }));
  }
  return inventorySkills(state)
    .filter((skill) => state.selected.has(skill.id))
    .map((skill) => ({
      id: skill.id,
      label: `${safe(skill.name)} · ${safe(skill.location.label)}${rpc ? ` · ${safe(skill.path)}` : ""}`,
      description: skill.path,
      statusText: skill.readOnlyReason ?? (skill.warnings.join("; ") || "Detected on disk"),
      detailDocument: {
        content: `${safe(skill.path)}\n${skill.warnings.map(safe).join("\n")}\n\n${skill.content}`,
        format: { kind: "text" as const },
      },
    }));
}

export function createSkillsMenu(
  state: State,
  start: Screen,
  env: Environment,
  owner: Guard,
  services: Services,
  mode: ExtensionCommandContext["mode"] = "tui",
) {
  const rpc = mode === "rpc";
  const managedSkill = () => managedSkills(state).find((skill) => skill.id === state.managedId);
  const readLoaded = (ctx: ExtensionCommandContext) => {
    state.loadedSkills = (ctx.getSystemPromptOptions().skills ?? []).map((skill) => ({
      ...skill,
      sourceInfo: { ...skill.sourceInfo },
    }));
    state.invocation = undefined;
    state.invocationReviewed = false;
  };
  const selectManaged = (operation: "remove" | "move") => {
    owner.check();
    const skill = managedSkill()?.local;
    if (!skill) throw new Error("Choose an installed skill");
    if (skill.readOnlyReason) throw new Error(skill.readOnlyReason);
    state.mode = operation;
    state.selected = new Set([skill.id]);
    state.batch = undefined;
    state.target = undefined;
    state.registration = undefined;
    state.registrationScope = "none";
  };
  const prepareRemoval = async (guard: Guard) => {
    const batch = await services.prepareOperation({ kind: "remove", skills: selectedLocals(state) }, guard);
    guard.check();
    state.batch = batch;
    return { kind: "to" as const, screen: "review" as const };
  };
  return defineMenu<State, Screen, Action>({
    start,
    screens: {
      main: () => ({
        kind: "actions",
        title: "Skills",
        lines: [
          `Workspace: ${safe(env.cwd)}`,
          ...state.warnings,
          ...(invocationNeedsReload(state)
            ? ["Model invocation settings saved on disk. Reload to refresh Pi's skill catalog."]
            : []),
        ],
        hint: "close",
        items: [
          { id: "manage", label: "Manage skills", action: "manage" },
          { id: "add", label: "Add from GitHub", action: "begin" },
          { id: "remove", label: "Remove skills", action: "begin" },
          { id: "move", label: "Move skills", action: "begin" },
          { id: "scan", label: "Scan custom directory", action: "manage-scan" },
          { id: "help", label: "Help", to: "help" },
          ...(invocationNeedsReload(state) ? [{ id: "reload", label: "Reload now", action: "reload" as const }] : []),
          { id: "close", label: invocationNeedsReload(state) ? "Close without reload" : "Close", close: true },
        ],
      }),
      source: () => ({
        kind: "input",
        title: "GitHub repository",
        placeholder: "owner/repo",
        initialValue: state.source,
        action: "source",
      }),
      fetch: () => ({
        kind: "actions",
        title: "Add from GitHub",
        lines: [`Repository: ${safe(state.source)}`, "Public source only. No repository programs will be executed."],
        items: [{ id: "discover", label: "Find skills", action: "discover", busyLabel: "Finding skills…" }],
      }),
      select: () => ({
        kind: "multiSelect",
        title: `${state.mode === "add" ? "Add" : state.mode === "remove" ? "Remove" : "Move"} skills`,
        lines:
          state.mode === "add"
            ? [
                `${safe(state.repository?.repository ?? "")} @ ${safe(state.repository?.commit ?? "")}`,
                "Select bundles; no files change until final confirmation.",
              ]
            : [
                "Select exact local paths. Checked names at different locations are separate skills.",
                ...state.inventory.warnings,
              ],
        items: selectionItems(state, rpc),
        action: "toggle",
        enableSearch: true,
        viewportSize: 10,
        actions: [
          {
            id: "continue",
            label: "Continue",
            action: "continue",
            busyLabel: state.mode === "remove" ? "Preparing removal…" : undefined,
          },
          { id: "preview", label: "Preview selected skills", to: "preview" },
          ...(state.mode === "add"
            ? []
            : [{ id: "scan", label: "Scan custom directory", to: "inventory-path" as const }]),
        ],
      }),
      preview: () => ({
        kind: "browse",
        title: "Selected skill contents",
        items: previewItems(state, rpc),
        enableDetailSearch: true,
      }),
      destination: () => ({
        kind: "choice",
        title: "Install destination",
        action: "target",
        initialItemId: "project-pi",
        lines: ["Project: this working directory. User: affects other projects. Shared: visible to compatible agents."],
        items: [
          ...state.locations.map((location) => ({
            id: location.id,
            label: rpc ? `${safe(location.label)} · ${safe(location.path)}` : location.label,
            description: location.path,
            disabled: Boolean(location.readOnlyReason),
            disabledReason: location.readOnlyReason,
          })),
          { id: "custom", label: "Custom directory", description: "Enter a skill-container path" },
        ],
      }),
      custom: () => ({
        kind: "input",
        title: "Custom skill directory",
        placeholder: "/path/to/skills",
        action: "custom",
      }),
      registration: () => ({
        kind: "choice",
        title: "Custom directory loading",
        action: "registration",
        initialItemId: "project",
        lines: [safe(state.target?.path ?? "")],
        items: [
          {
            id: "project",
            label: "Register for project",
            description: "Add a native project skills path",
            disabled: !env.isProjectTrusted(),
            disabledReason: "Project is not trusted",
          },
          {
            id: "user",
            label: "Register for user",
            description: "Add a native user skills path; affects other projects",
          },
          { id: "none", label: "Copy only", description: "Does not make this directory discoverable to Pi" },
        ],
      }),
      ready: () => ({
        kind: "actions",
        title: "Prepare changes",
        lines: [
          safe(state.target?.path ?? ""),
          `Custom registration: ${state.registrationScope}`,
          "Bundles keep supporting files; external references are not bundled.",
        ],
        items: [
          { id: "prepare", label: "Prepare review", action: "prepare", busyLabel: "Preparing selected bundles…" },
        ],
      }),
      review: () => ({
        kind: "review",
        title: "Confirm skill changes",
        viewportSize: "adaptive",
        enableSearch: true,
        content: [
          ...(state.repository && state.mode === "add"
            ? [`Source: ${safe(state.repository.repository)} @ ${safe(state.repository.commit)}`]
            : []),
          ...(state.batch?.summary.map(safe) ?? []),
          ...(state.registration
            ? [
                `Register ${safe(state.registration.storedPath)} in ${safe(state.registration.settingsPath)} (skills array).`,
              ]
            : []),
          ...(state.registrationScope === "none" && state.target?.id.startsWith("custom:")
            ? ["Copy only: this directory may not be discoverable."]
            : []),
          ...duplicateWarnings(state),
          "No overwrite or merge. Removal is permanent. A cancelled confirmed batch may be partially complete.",
        ].join("\n"),
        confirm: { id: "confirm", label: "Apply changes", action: "confirm" },
      }),
      manage: () => ({
        kind: "choice",
        title: "Manage skills",
        lines: ["Select a skill to manage it. Loaded and detected skills are listed.", ...state.inventory.warnings],
        items: managedItems(state, rpc),
        action: "manage-skill",
        initialItemId: state.managedId,
        enableSearch: true,
        viewportSize: 10,
      }),
      "skill-actions": () => {
        const skill = managedSkill();
        const blocked =
          skill?.local?.readOnlyReason ??
          (!skill?.local ? "Bundle actions require a scanned inventory entry" : undefined);
        const invocationBlocked = !skill?.loaded
          ? "Model invocation settings require a currently loaded Pi skill"
          : undefined;
        const invocationAction = {
          id: "model-invocation",
          label: "Model invocation",
          action: "select-invocation" as const,
          busyLabel: "Inspecting invocation target…",
          disabled: Boolean(invocationBlocked),
          disabledReason: invocationBlocked,
        };
        return {
          kind: "actions",
          title: skill ? `${safe(skill.name).trim() || "Unnamed skill"} · ${managedScope(skill)}` : "Skill unavailable",
          lines: [
            safe(skill?.filePath ?? ""),
            ...(skill?.local?.warnings.map(safe) ?? []),
            ...(blocked ? [safe(blocked)] : []),
            ...(state.copyMessage ? [state.copyMessage] : []),
          ],
          items: [
            ...(skill?.loaded ? [invocationAction] : []),
            { id: "move-one", label: "Move…", action: "move-one", disabled: Boolean(blocked), disabledReason: blocked },
            {
              id: "remove-one",
              label: "Remove…",
              action: "remove-one",
              busyLabel: "Preparing removal…",
              disabled: Boolean(blocked),
              disabledReason: blocked,
            },
            {
              id: "copy-directory",
              label: "Copy directory path",
              action: "copy-directory",
              busyLabel: "Copying directory path…",
              description: "Copy the exact directory path, including characters hidden by the preview.",
              disabled: mode !== "tui" || !skill,
              disabledReason: !skill
                ? "Choose an installed skill"
                : mode !== "tui"
                  ? "Clipboard copy requires Pi TUI"
                  : undefined,
            },
            ...(!skill?.loaded ? [invocationAction] : []),
            { id: "back", label: "Back", action: "back" },
          ],
        };
      },

      "invocation-review": () => ({
        kind: "review",
        title: "Review invocation target",
        content: [
          `Source file: ${safe(state.invocation?.filePath ?? "")}`,
          `Writes target: ${safe(state.invocation?.canonicalPath ?? "")}`,
          "Changing model invocation edits this source file, including a linked target or package file.",
          "User/shared edits can affect other projects. Package updates can overwrite changes.",
          "Open invocation setting only after reviewing the target. This review does not save anything.",
        ].join("\n\n"),
        viewportSize: "adaptive",
        enableSearch: true,
        ...(state.invocation
          ? { confirm: { id: "review-invocation", label: "Open invocation setting", action: "review-invocation" } }
          : {}),
      }),
      "invocation-setting": () => ({
        kind: "settings",
        title: "Model invocation",
        lines: [
          `Source file: ${safe(state.invocation?.filePath ?? "")}`,
          `Writes target: ${safe(state.invocation?.canonicalPath ?? "")}`,
          "Saves immediately, including linked targets. User/shared edits affect other projects; package updates can overwrite edits.",
          "Automatic advertises this skill to the model. Manual only hides it from discovery; /skill:name still works.",
          "Escape does not undo saves. Return to Skills for Reload now, or close without reload.",
        ],
        items: state.invocation
          ? [
              {
                id: "model-invocation",
                label: "Model invocation",
                disabled: !state.invocationReviewed,
                description:
                  "Changes the native disable-model-invocation field. Pi's current catalog changes only after reload.",
                currentValue: state.invocation.enabled ? "automatic" : "manual only",
                values: ["automatic", "manual only"],
                action: "save-invocation",
              },
            ]
          : [],
      }),
      help: () => ({ kind: "detail", title: "Skills help", lines: HELP }),
      "inventory-path": () => ({
        kind: "input",
        title: "Scan custom skill directory",
        placeholder: "/path/to/skills",
        action: "inventory-path",
      }),
      "inventory-ready": () => ({
        kind: "actions",
        title: "Scan local directory",
        lines: [safe(state.extra?.path ?? "")],
        items: [{ id: "scan", label: "Scan directory", action: "scan", busyLabel: "Scanning local skills…" }],
      }),
    },
    actions: {
      manage: ({ ctx }) => {
        owner.check();
        readLoaded(ctx);
        return { kind: "to", screen: "manage" };
      },
      "select-invocation": async ({ signal }) => {
        const guard = actionGuard(owner, signal);
        guard.check();
        const skill = managedSkill()?.loaded;
        const selectedId = state.managedId;
        if (!skill) throw new Error("Model invocation settings require a currently loaded Pi skill");
        const snapshot = await services.readInvocation(skill, guard);
        guard.check();
        if (state.managedId !== selectedId || managedSkill()?.loaded !== skill) return { kind: "rejected" };
        state.invocation = snapshot;
        state.invocationValues.set(snapshot.filePath, snapshot.enabled);
        state.invocationReviewed = false;
        return { kind: "to", screen: "invocation-review" };
      },
      "review-invocation": () => {
        owner.check();
        if (!state.invocation || managedSkill()?.loaded?.filePath !== state.invocation.filePath)
          throw new Error("Choose a currently loaded skill");
        state.invocationReviewed = true;
        return { kind: "to", screen: "invocation-setting" };
      },
      "save-invocation": async ({ ctx, value, signal }) => {
        const screenSignal = ctx.mode === "tui" ? state.invocationController?.signal : undefined;
        const guard = actionGuard(owner, screenSignal ? AbortSignal.any([signal, screenSignal]) : signal);
        try {
          guard.check();
          if (value !== "automatic" && value !== "manual only") throw new Error("Unknown model invocation value");
          if (
            !state.invocation ||
            !state.invocationReviewed ||
            managedSkill()?.loaded?.filePath !== state.invocation.filePath
          )
            throw new Error("Review the invocation target before changing its setting");
          const previous = state.invocation;
          const selectedId = state.managedId;
          const loaded = managedSkill()?.loaded;
          const result = await services.updateInvocation(previous, value === "automatic", guard);
          // Keep plain commit accounting even when cancellation follows publication.
          const current =
            state.managedId === selectedId && state.invocation === previous && managedSkill()?.loaded === loaded;
          if (current) state.invocation = result.snapshot;
          state.invocationValues.set(result.snapshot.filePath, result.snapshot.enabled);
          state.invocationChanged ||= result.changed;
          if (result.changed) {
            state.batch = undefined;
            // Invalidate before checking cancellation: a completed save must never
            // leave pre-save fingerprints available after Back or task disposal.
            state.inventory = {
              skills: [],
              warnings: ["Inventory refresh did not finish. Reopen /skills before managing bundles."],
            };
          }
          guard.check();
          if (!current) return { kind: "rejected" };
          if (result.changed) {
            try {
              const inventory = await services.scanInventory(state.locations, guard);
              guard.check();
              state.inventory = inventory;
            } catch (error) {
              guard.check();
              ctx.ui.notify(
                `Setting saved, but inventory refresh failed: ${safe(error instanceof Error ? error.message : String(error))}`,
                "warning",
              );
            }
          }
          return { kind: "stay" };
        } catch (error) {
          if (guard.signal.aborted) return { kind: "rejected" };
          throw error;
        }
      },
      reload: () => {
        owner.check();
        state.reload = true;
        return { kind: "close" };
      },
      "manage-scan": ({ ctx }) => {
        owner.check();
        readLoaded(ctx);
        state.afterScan = "manage";
        return { kind: "to", screen: "inventory-path" };
      },
      "manage-skill": ({ itemId }) => {
        owner.check();
        if (!managedSkills(state).some((skill) => skill.id === itemId))
          throw new Error("Skill is no longer in the managed catalog");
        state.managedId = itemId;
        state.invocation = undefined;
        state.invocationReviewed = false;
        state.copyMessage = undefined;
        return { kind: "to", screen: "skill-actions" };
      },
      "move-one": () => {
        selectManaged("move");
        return { kind: "to", screen: "destination" };
      },
      "remove-one": ({ signal }) => {
        selectManaged("remove");
        return prepareRemoval(actionGuard(owner, signal));
      },
      "copy-directory": async ({ ctx, signal }) => {
        const guard = actionGuard(owner, signal);
        guard.check();
        if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Clipboard copy requires Pi TUI");
        const skill = managedSkill();
        if (!skill) throw new Error("Choose an installed skill");
        state.copyMessage = undefined;
        // Pi exposes no abort signal for clipboard writes. Drain accepted work;
        // cancellation cannot undo a write and must not publish stale feedback.
        await services.copyToClipboard(skill.directoryPath);
        guard.check();
        state.copyMessage = "Directory path sent to clipboard";
        return { kind: "stay" };
      },
      back: () => {
        owner.check();
        return { kind: "back" };
      },
      begin: ({ itemId }) => {
        if (itemId !== "add" && itemId !== "remove" && itemId !== "move") throw new Error("Unknown operation");
        owner.check();
        state.mode = itemId;
        state.selected.clear();
        state.batch = undefined;
        state.target = undefined;
        state.registration = undefined;
        state.registrationScope = "none";
        state.afterScan = "select";
        return { kind: "to", screen: itemId === "add" ? "source" : "select" };
      },
      source: ({ value }) => {
        owner.check();
        state.source = parseRepository(value ?? "");
        return { kind: "to", screen: "fetch" };
      },
      discover: async ({ signal }) => {
        const guard = actionGuard(owner, signal);
        const repository = await services.discoverRepository(state.source, guard.signal);
        guard.check();
        state.repository = repository;
        state.selected.clear();
        return { kind: "to", screen: "select" };
      },
      toggle: ({ itemId, selected }) => {
        owner.check();
        if (selected) state.selected.add(itemId);
        else state.selected.delete(itemId);
        state.batch = undefined;
        return { kind: "stay" };
      },
      continue: async ({ signal }) => {
        owner.check();
        if (state.selected.size === 0) throw new Error("Select at least one skill");
        if (state.mode !== "remove") return { kind: "to", screen: "destination" };
        return prepareRemoval(actionGuard(owner, signal));
      },
      target: ({ itemId }) => {
        owner.check();
        state.registration = undefined;
        state.registrationScope = "none";
        if (itemId === "custom") return { kind: "to", screen: "custom" };
        const target = state.locations.find((location) => location.id === itemId);
        if (!target || target.readOnlyReason) throw new Error("Destination is unavailable");
        state.target = target;
        return { kind: "to", screen: "ready" };
      },
      custom: ({ value }) => {
        owner.check();
        const target = services.customLocation(value ?? "", env);
        if (target.readOnlyReason) throw new Error(target.readOnlyReason);
        state.target = target;
        return { kind: "to", screen: "registration" };
      },
      registration: ({ itemId }) => {
        owner.check();
        if (itemId !== "project" && itemId !== "user" && itemId !== "none")
          throw new Error("Unknown registration scope");
        state.registrationScope = itemId;
        return { kind: "to", screen: "ready" };
      },
      prepare: async ({ signal }) => {
        const guard = actionGuard(owner, signal);
        guard.check();
        const target = state.target;
        if (!target) throw new Error("Choose a destination");
        const registration = await services.previewRegistration(target.path, state.registrationScope, env, guard);
        guard.check();
        let request: OperationRequest;
        if (state.mode === "add") {
          if (!state.repository) throw new Error("Find repository skills first");
          const bundles = await services.downloadBundles(state.repository, [...state.selected], guard.signal);
          guard.check();
          request = { kind: "add", target, bundles };
        } else request = { kind: "move", target, skills: selectedLocals(state) };
        const batch = await services.prepareOperation(request, guard);
        guard.check();
        state.registration = registration;
        state.batch = batch;
        return { kind: "to", screen: "review" };
      },
      confirm: () => {
        owner.check();
        if (!state.batch) throw new Error("Prepare changes first");
        state.confirmed = true;
        return { kind: "close" };
      },
      "inventory-path": ({ value }) => {
        owner.check();
        state.extra = services.customLocation(value ?? "", env);
        return { kind: "to", screen: "inventory-ready" };
      },
      scan: async ({ signal }) => {
        const guard = actionGuard(owner, signal);
        if (!state.extra) throw new Error("Enter a directory");
        const locations = [...state.locations.filter((location) => location.path !== state.extra?.path), state.extra];
        const inventory = await services.scanInventory(locations, guard);
        guard.check();
        state.locations = locations;
        state.inventory = inventory;
        return { kind: "to", screen: state.afterScan };
      },
    },
  });
}

function duplicateWarnings(state: State) {
  if (state.mode !== "add") return [];
  const selected = state.repository?.skills.filter((skill) => state.selected.has(skill.id)) ?? [];
  return selected.flatMap((candidate) => {
    const existing = inventorySkills(state).filter((skill) => skill.name === candidate.name);
    return existing.map(
      (skill) =>
        `Name conflict: ${safe(candidate.name)} also exists at ${safe(skill.path)}. Pi decides discovery precedence.`,
    );
  });
}

export async function showSkillsMenu(
  ctx: ExtensionCommandContext,
  route: Route,
  env: Environment,
  owner: Guard,
  services: Services = defaultServices,
): Promise<boolean> {
  const onError = (_ctx: unknown, error: unknown) => {
    owner.check();
    ctx.ui.notify(safe(error instanceof Error ? error.message : String(error)), "error");
  };
  const initial = await runTask(ctx, {
    label: route.repository ? "Finding repository skills…" : "Scanning local skills…",
    signal: owner.signal,
    isCurrent: () => !owner.signal.aborted,
    onError,
    task: async ({ signal }) => {
      const guard = actionGuard(owner, signal);
      const locations = await services.loadLocations(env, guard);
      guard.check();
      const inventory = await services.scanInventory(locations.locations, guard);
      guard.check();
      const repository = route.repository
        ? await services.discoverRepository(route.repository, guard.signal)
        : undefined;
      guard.check();
      return { locations, inventory, repository };
    },
  });
  owner.check();
  if (initial.kind !== "completed") return false;
  const state: State = {
    mode: route.kind === "remove" || route.kind === "move" ? route.kind : "add",
    source: route.repository ?? "",
    repository: initial.value.repository,
    selected: new Set(),
    locations: initial.value.locations.locations,
    inventory: initial.value.inventory,
    warnings: initial.value.locations.warnings.map(safe),
    registrationScope: "none",
    confirmed: false,
    afterScan: route.kind === "main" ? "manage" : "select",
    loadedSkills: [],
    invocationChanged: false,
    invocationValues: new Map(),
    reload: false,
  };
  const start: Screen =
    route.kind === "main" ? "main" : route.kind === "add" && !route.repository ? "source" : "select";
  await runMenu(invocationContext(ctx, state, owner), createSkillsMenu(state, start, env, owner, services, ctx.mode), {
    getState: () => state,
    signal: owner.signal,
    isCurrent: () => !owner.signal.aborted,
    onError,
  });
  owner.check();
  if (state.reload) return true;
  if (!state.confirmed || !state.batch) return false;
  const batch = state.batch;
  let results: OperationResult[] = [];
  const applying = await runTask(ctx, {
    label: "Applying skill changes…",
    signal: owner.signal,
    isCurrent: () => !owner.signal.aborted,
    onError,
    task: async ({ signal }) => {
      const guard = actionGuard(owner, signal);
      results = await batch.apply(
        guard,
        state.registration
          ? () => services.applyRegistration(state.registration as RegistrationPlan, env, guard)
          : undefined,
      );
      // Keep plain partial results even when the task was cancelled during a safe step.
      return results;
    },
  });
  owner.check();
  if (results.length === 0 && applying.kind !== "completed") return false;
  return showResults(ctx, results, owner, invocationNeedsReload(state));
}

async function showResults(
  ctx: ExtensionCommandContext,
  results: OperationResult[],
  owner: Guard,
  pendingReload = false,
) {
  let reload = false;
  const content = results
    .map((result) =>
      [result.status.toUpperCase(), result.source, result.destination, result.message]
        .filter((value): value is string => value !== undefined)
        .map(safe)
        .join("\n"),
    )
    .join("\n\n");
  const counts = [...new Set(results.map((result) => result.status))].map(
    (status) => `${status}: ${results.filter((result) => result.status === status).length}`,
  );
  const menu = defineMenu<undefined, "summary" | "results", "reload">({
    start: "summary",
    screens: {
      summary: () => ({
        kind: "actions",
        title: "Skill changes",
        lines: counts,
        hint: "close",
        items: [
          { id: "results", label: "View results", to: "results" },
          ...(pendingReload || results.some((result) => result.changed)
            ? [{ id: "reload", label: "Reload now", action: "reload" as const }]
            : []),
          { id: "later", label: "Close without reload", close: true },
        ],
      }),
      results: () => ({
        kind: "review",
        title: "Operation results",
        content,
        viewportSize: "adaptive",
        enableSearch: true,
      }),
    },
    actions: {
      reload: () => {
        owner.check();
        reload = true;
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, { getState: () => undefined, signal: owner.signal, isCurrent: () => !owner.signal.aborted });
  owner.check();
  return reload;
}
