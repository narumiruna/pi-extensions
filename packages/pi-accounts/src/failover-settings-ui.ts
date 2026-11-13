import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  HorizontalRule,
  renderBoundedFrameLayout,
  runCustomInteraction,
  sanitizeTerminalText,
} from "@narumitw/pi-tui-kit";
import { ACCOUNTS_FILE, type AccountStore } from "./account-store.js";
import { type FailoverSettings, readFailoverSettings, updateFailoverSettings } from "./failover-settings.js";
import type { AccountProviderId } from "./oauth.js";

export type FailoverSettingsOwner = { signal: AbortSignal; isCurrent(): boolean };
type CloseReason = "back" | "close" | "stale";

function sameSettings(left: FailoverSettings, right: FailoverSettings): boolean {
  return (
    left.enabled === right.enabled &&
    left.minRemainingPercent === right.minRemainingPercent &&
    left.accounts.length === right.accounts.length &&
    left.accounts.every((name, index) => name === right.accounts[index])
  );
}

export function failoverSettingsManualPath(): string {
  return sanitizeTerminalText(join(getAgentDir(), ACCOUNTS_FILE));
}

/** The owner retains policy state; this screen applies changes only after a durable save. */
export async function showFailoverSettings(
  ctx: ExtensionCommandContext,
  store: AccountStore,
  providerId: AccountProviderId,
  providerName: string,
  owner: FailoverSettingsOwner,
  changed: (providerId: string) => Promise<void> = async () => {},
): Promise<CloseReason> {
  const owned = () => owner.isCurrent() && !owner.signal.aborted;
  if (!owned()) return "stale";
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Edit providers.${providerId}.fallback in ${failoverSettingsManualPath()}, then run /reload. Interactive Settings require TUI mode.`,
        "info",
      );
    }
    return "back";
  }
  const state = await store.readProviderAsync(providerId, owner.signal);
  if (!owned()) return "stale";
  const initial = readFailoverSettings(state);
  if (initial.error) {
    ctx.ui.notify(
      `${initial.error} Repair providers.${providerId}.fallback in ${failoverSettingsManualPath()}, then run /reload.`,
      "error",
    );
    return "back";
  }
  let effective = initial.settings;
  let accountNames = Object.keys(state.accounts)
    .filter((name) => name !== "default")
    .sort();
  const result = await runCustomInteraction<CloseReason>(ctx, {
    signal: owner.signal,
    isCurrent: owner.isCurrent,
    create({ tui, theme, signal, complete }) {
      let queue = Promise.resolve();
      let disposed = false;
      let revision = 0;
      const pending = new Map<string, number>();
      const current = () => !disposed && !signal.aborted && owned();
      const view: { title: string; footer: boolean; input?: Input } = { title: "", footer: true };
      const mouseRows = new Map<number, number>();
      let renderedWidth = 0;
      let contentHeight = 0;
      let mousePressed = false;
      let focused = false;
      let activeInput: Input | undefined;
      let inputPaste = false;
      let inputPasteTail = "";
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      // Keep native behavior, but use the callback theme and omit the native fixed-key footer.
      const listTheme = {
        ...getSettingsListTheme(),
        label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
        value: (text: string, selected: boolean) => theme.fg(selected ? "accent" : "muted", text),
        description: (text: string) => theme.fg("muted", text),
        cursor: theme.fg("accent", "→ "),
        hint: (text: string) => theme.fg("muted", text),
      };
      const selectorTheme = {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("muted", text),
        noMatch: (text: string) => theme.fg("muted", text),
      };
      const notify = (message: string) => {
        if (!current()) return;
        try {
          ctx.ui.notify(message, "error");
        } catch {
          // The host can release its notifier after the ownership check.
        }
      };
      const notifyFailure = () =>
        notify(
          "Could not save account failover settings. Previous settings remain effective; check storage and try again.",
        );
      const updateRows = () => {
        if (!pending.has("enabled")) list.updateValue("enabled", String(effective.enabled));
        if (!pending.has("threshold")) list.updateValue("threshold", String(effective.minRemainingPercent));
        list.updateValue("backups", effective.accounts.length ? effective.accounts.join(" → ") : "none");
      };
      const enqueue = (id: string, update: (settings: FailoverSettings) => FailoverSettings) => {
        if (!current()) return;
        const request = ++revision;
        pending.set(id, request);
        queue = queue
          .then(async () => {
            if (!current()) return;
            let before: FailoverSettings | undefined;
            let saved: FailoverSettings | undefined;
            try {
              const next = await updateFailoverSettings(
                store,
                providerId,
                (settings, latest) => {
                  before = settings;
                  accountNames = Object.keys(latest.accounts)
                    .filter((name) => name !== "default")
                    .sort();
                  return update(settings);
                },
                signal,
                current,
              );
              saved = next;
              // A durable save belongs to the session, not the closed screen. Drain runtime
              // application before command completion, but never publish to a stale session.
              if (!owned()) return;
              await changed(providerId);
              if (!owned()) return;
              if (current()) effective = next;
            } catch {
              if (!owned()) return;
              if (saved && before) {
                try {
                  const expected = saved;
                  const previous = before;
                  // Compare under the same lock as publication: never undo a newer manual
                  // policy edit, repair an invalid block, or restore removed references.
                  await store.updateProviderAsync(
                    providerId,
                    async (state) => {
                      if (!owned()) throw new DOMException("Settings owner changed", "AbortError");
                      const latest = readFailoverSettings(state);
                      if (
                        latest.error ||
                        !sameSettings(latest.settings, expected) ||
                        previous.accounts.some((name) => !Object.hasOwn(state.accounts, name))
                      ) {
                        throw new Error("Settings changed before restoration");
                      }
                      return { ...state, fallback: { ...(state.fallback as Record<string, unknown>), ...previous } };
                    },
                    owner.signal,
                  );
                  if (!owned()) return;
                  await changed(providerId);
                  if (!owned()) return;
                } catch {
                  notify(
                    "Failover settings could not be restored. Check the settings file and run /reload before continuing.",
                  );
                  complete("close");
                  return;
                }
              }
              notifyFailure();
            } finally {
              if (pending.get(id) === request) pending.delete(id);
              if (current()) {
                updateRows();
                tui.requestRender();
              }
            }
          })
          .catch(notifyFailure);
      };
      const selector = (
        title: string,
        rows: SelectItem[],
        onSelect: (value: string) => void,
        back: () => void,
      ): Component => {
        const select = new SelectList(rows, 10, selectorTheme);
        select.onSelect = (item) => {
          if (current()) onSelect(item.value);
        };
        select.onCancel = back;
        return {
          render(width) {
            view.title = title;
            view.footer = false;
            return select.render(width);
          },
          invalidate: () => select.invalidate(),
          handleInput: (data) => select.handleInput(data),
          handleMouse: (event) => select.handleMouse(event),
        };
      };
      const backups: NonNullable<SettingItem["submenu"]> = (_value, done) => {
        let builtRevision = -1;
        let backupList: SettingsList;
        let selectedId = effective.accounts[0] ? `backup:${effective.accounts[0]}` : "add";
        const rebuild = () => {
          const rows: SettingItem[] = [
            ...effective.accounts.map((name, index) => ({
              id: `backup:${name}`,
              label: `${index + 1}. ${sanitizeTerminalText(name)}`,
              currentValue: "Manage",
              submenu: (_current: string, leave: (value?: string) => void) =>
                selector(
                  `Backup: ${sanitizeTerminalText(name)}`,
                  [
                    { value: "remove", label: "Remove backup" },
                    ...(index > 0 ? [{ value: "up", label: "Move earlier" }] : []),
                    ...(index + 1 < effective.accounts.length ? [{ value: "down", label: "Move later" }] : []),
                  ],
                  (action) => {
                    selectedId = `backup:${name}`;
                    enqueue("backups", (settings) => {
                      const names = [...settings.accounts];
                      const position = names.indexOf(name);
                      if (position < 0) throw new Error("Backup no longer exists");
                      if (action === "remove") names.splice(position, 1);
                      else {
                        const target = position + (action === "up" ? -1 : 1);
                        if (target < 0 || target >= names.length) throw new Error("Backup order changed");
                        [names[position], names[target]] = [names[target] as string, name];
                      }
                      return { ...settings, accounts: names, enabled: settings.enabled && names.length > 0 };
                    });
                    leave();
                  },
                  () => leave(),
                ),
            })),
            {
              id: "add",
              label: "Add backup",
              currentValue: "Select account",
              description:
                "Only saved accounts under this provider can be backups. Removing the last backup disables failover.",
              submenu: (_current, leave) =>
                selector(
                  "Add backup account",
                  accountNames
                    .filter((name) => !effective.accounts.includes(name))
                    .map((name) => ({ value: name, label: sanitizeTerminalText(name) })),
                  (name) => {
                    selectedId = "add";
                    enqueue("backups", (settings) => ({ ...settings, accounts: [...settings.accounts, name] }));
                    leave();
                  },
                  () => leave(),
                ),
            },
          ];
          backupList = new SettingsList(
            rows,
            10,
            listTheme,
            () => {},
            () => done(),
          );
          backupList.selectItem(selectedId);
          builtRevision = revision;
        };
        rebuild();
        return {
          render(width) {
            // Do not replace an open native submenu while a save is still pending.
            if (builtRevision !== revision && !pending.has("backups")) rebuild();
            view.title = "Ordered backup accounts";
            return backupList.render(width);
          },
          invalidate: () => backupList.invalidate(),
          handleInput: (data) => backupList.handleInput(data),
          handleMouse: (event) => backupList.handleMouse(event),
        };
      };
      const items: SettingItem[] = [
        {
          id: "enabled",
          label: "Failover enabled",
          description:
            "Requires saved backups and fresh, verified usage evidence. PI_ACCOUNT prevents automatic switching.",
          currentValue: String(effective.enabled),
          values: ["false", "true"],
        },
        {
          id: "threshold",
          label: "Minimum remaining (%)",
          currentValue: String(effective.minRemainingPercent),
          description:
            "Switch only when applicable remaining allowance is at or below this threshold (0 to less than 100).",
          submenu: (value, done) => {
            const input = new Input();
            activeInput = input;
            inputPaste = false;
            inputPasteTail = "";
            input.focused = focused;
            // Native paste initializes the draft with its cursor after the current value.
            input.handleInput(`\u001b[200~${value}\u001b[201~`);
            let error = "";
            input.onEscape = () => {
              activeInput = undefined;
              done();
            };
            input.onSubmit = (text) => {
              const next = text.trim() ? Number(text) : Number.NaN;
              if (!Number.isFinite(next) || next < 0 || next >= 100) {
                error = "Enter a finite number from 0 to less than 100.";
                return;
              }
              activeInput = undefined;
              done(String(next));
            };
            return {
              render() {
                view.title = "Minimum remaining (%)";
                view.footer = false;
                view.input = input;
                return [...input.render(Math.max(1, renderedWidth)), ...(error ? [theme.fg("error", error)] : [])];
              },
              invalidate: () => input.invalidate(),
              handleInput: (data) => input.handleInput(data),
              handleMouse: (event) => (event.y === 0 ? input.handleMouse(event) : undefined),
            };
          },
        },
        {
          id: "backups",
          label: "Ordered backups",
          currentValue: effective.accounts.length ? effective.accounts.join(" → ") : "none",
          description: "Add, remove, or reorder backup accounts. Changes save immediately.",
          submenu: backups,
        },
      ];
      const list = new SettingsList(
        items,
        items.length,
        listTheme,
        (id, value) => {
          if (id === "enabled") enqueue(id, (settings) => ({ ...settings, enabled: value === "true" }));
          if (id === "threshold") enqueue(id, (settings) => ({ ...settings, minRemainingPercent: Number(value) }));
        },
        () => complete("back"),
      );
      return {
        capturesViewportInput: true,
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          if (activeInput) activeInput.focused = value;
        },
        render(width) {
          if (!current()) return [];
          renderedWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
          view.title = `${sanitizeTerminalText(providerName)} Failover Settings`;
          listTheme.cursor = theme.fg("accent", "→ ");
          view.footer = true;
          view.input = undefined;
          const native = list.render(Math.max(8, renderedWidth));
          const content = view.footer ? native.slice(0, -2) : native;
          contentHeight = content.length;
          const focusedRow = view.input
            ? 0
            : content.findIndex((line) => stripVTControlCharacters(line).startsWith("→"));
          const rows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const frame = renderBoundedFrameLayout({
            width: renderedWidth,
            maxRows: Math.max(1, rows - 3),
            rule: rule.render(renderedWidth)[0] ?? "",
            title: [theme.fg("accent", theme.bold(view.title))],
            context: [theme.fg("muted", "Changes save immediately. Back does not undo saved changes.")],
            content,
            hints: [theme.fg("muted", "Ctrl+C close")],
            priorityRows: focusedRow < 0 ? [] : [focusedRow],
            focusedRow,
          });
          mouseRows.clear();
          for (const { frameIndex, contentIndex } of frame.contentRows) mouseRows.set(frameIndex, contentIndex);
          return frame.lines;
        },
        invalidate() {
          mouseRows.clear();
          mousePressed = false;
          rule.invalidate();
          list.invalidate();
        },
        handleInput(data) {
          if (!current()) return;
          mouseRows.clear();
          mousePressed = false;
          // An embedded Input owns paste contents, including bytes that match cancel keys.
          const pasted = activeInput !== undefined && (inputPaste || data.includes("\u001b[200~"));
          if (pasted) {
            const tail = inputPasteTail + data;
            inputPaste = !tail.includes("\u001b[201~");
            inputPasteTail = inputPaste ? tail.slice(-5) : "";
            list.handleInput(data);
          } else if (matchesKey(data, Key.ctrl("c"))) complete("close");
          else list.handleInput(data);
          tui.requestRender();
        },
        handleMouse(event: TuiMouseEvent) {
          if (!current()) return;
          const row = mouseRows.get(event.y);
          if (row === undefined || event.width !== renderedWidth || event.x < 0 || event.x >= renderedWidth) {
            mousePressed = false;
            return;
          }
          const nativeEvent = { ...event, y: row, width: Math.max(8, renderedWidth), height: contentHeight };
          if (event.type === "click" && event.button === "left" && !mousePressed)
            list.handleMouse({ ...nativeEvent, type: "press" });
          const handled = list.handleMouse(nativeEvent);
          if (event.type === "press" && event.button === "left") mousePressed = handled?.handled === true;
          if (event.type === "click" || event.type === "wheel") mousePressed = false;
          if (handled?.handled && handled.render !== false) tui.requestRender();
          return handled;
        },
        waitForPending: () => queue,
        dispose() {
          disposed = true;
          activeInput = undefined;
          inputPaste = false;
          inputPasteTail = "";
          mouseRows.clear();
          mousePressed = false;
        },
      };
    },
  });
  if (result.kind === "error") throw result.error;
  return result.kind === "completed" ? result.value : "stale";
}
