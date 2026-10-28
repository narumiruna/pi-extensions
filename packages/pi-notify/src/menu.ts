import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, runSecretInput, runTask } from "@narumitw/pi-tui-kit";
import type { Coordinator } from "./coordinator.js";
import {
  credentialLabels,
  destinationDescription,
  destinationLines,
  displayServerUrl,
  providerLabel,
} from "./destination-ui.js";
import { displayPath, notificationMetadata, safeText } from "./metadata.js";
import type { Destination, Notification, Providers } from "./provider.js";
import {
  policyKeys,
  resolveSettings,
  type Scope,
  type Settings,
  type SettingsStore,
  type Snapshot,
  saveDestination,
  savePolicy,
  validSeconds,
} from "./settings.js";

type Screen =
  | "main"
  | "destinations"
  | "addDestination"
  | "destination"
  | "settings"
  | "targets"
  | "delay"
  | "customDelay"
  | "label"
  | "chat"
  | "topic"
  | "serverUrl"
  | "priority"
  | "ntfyTopic"
  | "review"
  | "remove"
  | "testSelect"
  | "testReview"
  | "status"
  | "help";
type Action =
  | "scope"
  | "policy"
  | "delay"
  | "customDelay"
  | "target"
  | "inheritTargets"
  | "add"
  | "addGotify"
  | "addSlack"
  | "addNtfy"
  | "addPushover"
  | "addDiscord"
  | "addBark"
  | "addWebhook"
  | "addTeams"
  | "addLine"
  | "recipientId"
  | "userKey"
  | "bearerToken"
  | "ntfyTopic"
  | "edit"
  | "select"
  | "token"
  | "label"
  | "chat"
  | "topic"
  | "serverUrl"
  | "priority"
  | "save"
  | "saveOnly"
  | "remove"
  | "prepareTest"
  | "sendTest";
interface State {
  snapshot: Snapshot;
  editing: Settings;
}
export interface MenuOptions {
  store: SettingsStore;
  coordinator: Coordinator;
  providers: Providers;
  signal: AbortSignal;
  isCurrent(): boolean;
}
export const helpLines = [
  "Create a bot with @BotFather in Telegram, then start a private conversation or add it to your group with permission to send messages.",
  "Obtain the numeric chat ID from Telegram Bot API getUpdates after sending a message. Do not share or paste the token into Pi chat. Stop other update consumers before using getUpdates; this extension does not poll.",
  "Telegram setup needs a bot token and chat ID. Labels are generated automatically. Edit the label or optional forum topic ID from the destination review.",
  "For Gotify, create an application on your server and use its application token, not a client token. Enter the server base URL, including any reverse-proxy path. Prefer HTTPS; HTTP sends credentials without encryption.",
  "Gotify labels are generated automatically. Edit the label or optional safe-integer priority from the destination review. An empty priority uses the server default.",
  "For Slack, enable Incoming Webhooks in a Slack app and add a webhook to your workspace. Its installation fixes the channel. Paste the complete hooks.slack.com URL only into the masked field; never into Pi chat.",
  "Slack webhook URLs are secrets. Reviews and Status show only that a webhook is configured. Revoke an exposed webhook in the Slack app before replacing it.",
  "For Microsoft Teams, create a Workflows webhook with Anyone authentication. Enter its complete current signed URL only in the masked field. The workflow owns its target. HTTP 202 means trigger acceptance, not proof of a Teams post; live interoperability is not yet verified. See docs/settings.md for supported URLs, setup, and revocation.",
  "For LINE, enable Messaging API on an Official Account and enter its channel access token and user/group/room ID in masked inputs. Recipient eligibility and account quotas apply. LINE Notify is not supported. See docs/settings.md for setup and revocation.",
  "For ntfy, subscribe to a topic and configure server authentication and topic permissions. Topic secrecy is not access control. Review the server, optional Bearer token, and priority from 1 to 5.",
  "For Pushover, enter the application token and user key in masked inputs. Delivery uses normal priority only, without emergency acknowledgement or retries.",
  "For Discord, paste a normal text-channel webhook URL into the masked input. Mentions and link embeds are disabled; forum/media channels and thread selection are not supported.",
  "For Bark, enter the device key in the masked input and review the hosted or self-hosted server base. JSON delivery keeps the key and message out of URLs, not server body logs. Native Basic authentication is not supported.",
  "For Generic webhooks, enter the endpoint in the masked input and set an optional Bearer token in review. The fixed JSON payload has id, title, body, and settledAt (Unix milliseconds); no templates or custom headers.",
  "Self-hosted ntfy, Bark, and Generic endpoints can reach private networks. Prefer HTTPS; HTTP sends credentials and metadata without encryption. See the bundled docs/settings.md for setup and revocation.",
  "Use a negative group/supergroup chat ID when applicable. Forum topic IDs are optional positive integers.",
  "Destinations are User settings only. Project settings require trust and may select existing destinations but cannot change credentials or addresses.",
  "Notifications disclose hostname, session name/ID, workspace and Git metadata, elapsed time and timestamp. No conversation or code is sent.",
  "Inactivity uses only input Pi forwards to this extension. Fullscreen focus, mouse, and viewport/search keys can be consumed first and do not reliably cancel reminders. Reading without typing can still trigger a notification.",
  "Input or new work cancels a pending reminder. Saved policy/destination changes cancel pending reminders. Settings save immediately; closing does not undo them.",
  "RPC/print/JSON cannot observe terminal activity and deliver at settlement instead. Short-lived processes can exit before delivery completes.",
  "Delivery is best effort, one attempt, with no automatic retries or history replay. Accepted means the provider accepted the message, not that it was read.",
  "Manual file changes require /reload or session start. Repair malformed files before saving. Revoke exposed Telegram tokens through BotFather or Gotify application tokens on your server.",
];

export async function showNotifyMenu(ctx: ExtensionCommandContext, options: MenuOptions) {
  const { store, coordinator, providers, signal, isCurrent } = options;
  // Kit reserves one column internally; preserve the host's zero-width contract.
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, customOptions) =>
    ctx.ui.custom(async (...args) => {
      const component = await factory(...args);
      const render = component.render.bind(component);
      component.render = (width) => (width <= 0 ? [] : render(width));
      return component;
    }, customOptions);
  const menuCtx = { ...ctx, ui: { ...ctx.ui, custom } };
  let scope: Scope = "user";
  let selectedId = "";
  let draft: Destination | undefined;
  let testNotification: Notification | undefined;
  let testDestination: Destination | undefined;
  const current = () => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error("Session replaced.");
  };
  const apply = async (operation: Promise<Snapshot>) => {
    const snapshot = await operation;
    current();
    coordinator.apply(snapshot.effective);
  };
  const knownDestination = () => {
    const destination = store.snapshot.effective.destinations[selectedId];
    if (!destination) throw new Error("Destination is unavailable.");
    return destination;
  };
  const assertDraft = () => {
    if (!draft) throw new Error("Destination draft is unavailable.");
    return draft;
  };
  const telegramDraft = () => {
    const destination = assertDraft();
    if (destination.provider !== "telegram") throw new Error("Not a Telegram destination.");
    return destination;
  };
  const ntfyDraft = () => {
    const destination = assertDraft();
    if (destination.provider !== "ntfy") throw new Error("Not an ntfy destination.");
    return destination;
  };
  const serverDraft = () => {
    const destination = assertDraft();
    if (destination.provider !== "gotify" && destination.provider !== "ntfy" && destination.provider !== "bark")
      throw new Error("Not a server destination.");
    return destination;
  };
  const priorityDraft = () => {
    const destination = serverDraft();
    if (destination.provider === "bark") throw new Error("Priority is unavailable.");
    return destination;
  };
  const reportError = () => {
    if (isCurrent())
      ctx.ui.notify(
        "Notify operation failed. Check the input, settings file, and Project selections. No credential values are shown.",
        "error",
      );
  };
  const saveDraft = async (actionSignal: AbortSignal, selectNew: boolean) => {
    const value = assertDraft();
    const destination = providers.get(value.provider)?.validate(value);
    if (!destination) throw new Error("Invalid destination settings. Check the required fields.");
    await apply(saveDestination(store, selectedId, destination, actionSignal, selectNew));
    draft = undefined;
    return { kind: "to", screen: "main" } as const;
  };
  const addWebhook = async (provider: "discord" | "webhook" | "teams", actionSignal: AbortSignal) => {
    const result = await runSecretInput(menuCtx, {
      title:
        provider === "teams"
          ? "Teams workflow webhook URL"
          : `${provider === "discord" ? "Discord" : "Generic webhook"} URL`,
      signal: actionSignal,
      isCurrent,
      onError: reportError,
    });
    actionSignal.throwIfAborted();
    current();
    if (result.kind === "closed" && result.reason === "close") return { kind: "close" } as const;
    if (result.kind !== "submitted") return { kind: "stay" } as const;
    const destination = providers.get(provider)?.validate({
      provider,
      label:
        provider === "teams"
          ? "Microsoft Teams notifications"
          : provider === "discord"
            ? "Discord notifications"
            : "Generic webhook notifications",
      webhookUrl: result.value,
    });
    if (!destination) throw new Error("Use a valid webhook URL.");
    selectedId = randomUUID();
    draft = destination;
    return { kind: "to", screen: "review" } as const;
  };
  const menu = defineMenu<State, Screen, Action>({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Notify",
        lines: [
          `Notifications: ${state.snapshot.effective.enabled ? "enabled" : "disabled"} · ${state.snapshot.effective.mode}`,
          `Selected: ${state.snapshot.effective.targetIds.map((id) => safeText(state.snapshot.effective.destinations[id]?.label ?? id)).join(", ") || "none"}`,
          `Editing: ${scope === "user" ? "User" : "Project"}`,
          ...state.snapshot.diagnostics,
        ],
        items: [
          { id: "destinations", label: "Destinations", to: "destinations" },
          { id: "test", label: "Send test…", to: "testSelect" },
          { id: "settings", label: "Settings", to: "settings" },
          { id: "status", label: "Status", to: "status" },
          { id: "help", label: "Help", to: "help" },
        ],
        hint: "close",
      }),
      destinations: ({ state }) => ({
        kind: "actions",
        title: "Destinations · User",
        items: [
          ...Object.entries(state.snapshot.effective.destinations).map(([id, value]) => ({
            // Stored IDs cannot contain ':', so rows cannot shadow the add actions.
            id: `destination:${id}`,
            label: safeText(value.label),
            description: destinationDescription(value),
            action: "select" as const,
          })),
          { id: "add:destination", label: "Add destination…", to: "addDestination" },
        ],
      }),
      addDestination: () => ({
        kind: "actions",
        title: "Add destination · User",
        items: [
          { id: "add", label: "Add Telegram destination", action: "add" },
          { id: "addGotify", label: "Add Gotify destination", action: "addGotify" },
          { id: "addSlack", label: "Add Slack destination", action: "addSlack" },
          { id: "addNtfy", label: "Add ntfy destination", action: "addNtfy" },
          { id: "addPushover", label: "Add Pushover destination", action: "addPushover" },
          { id: "addDiscord", label: "Add Discord destination", action: "addDiscord" },
          { id: "addBark", label: "Add Bark destination", action: "addBark" },
          { id: "addWebhook", label: "Add Generic webhook destination", action: "addWebhook" },
          { id: "addLine", label: "Add LINE destination", action: "addLine" },
          { id: "addTeams", label: "Add Microsoft Teams destination", action: "addTeams" },
        ],
      }),
      destination: () => ({
        kind: "actions",
        title: `${providerLabel(knownDestination())} destination · User`,
        lines: destinationLines(knownDestination()),
        items: [
          { id: "edit", label: "Edit destination", action: "edit" },
          { id: "remove", label: "Remove destination…", to: "remove" },
        ],
      }),
      settings: ({ state }) => {
        const own = state.snapshot[scope];
        const inherited = (key: (typeof policyKeys)[number]) => scope === "project" && !Object.hasOwn(own, key);
        return {
          kind: "settings",
          title: `Notify Settings · ${scope === "user" ? "User" : "Project"}`,
          lines: ["Changes save immediately. Closing does not undo saved changes."],
          items: [
            {
              id: "scope",
              label: "Scope",
              currentValue: scope === "user" ? "User" : "Project",
              values: ["User", "Project"],
              action: "scope",
              description: store.projectPath
                ? "Project overrides require trust."
                : "Project scope is unavailable until trusted.",
            },
            {
              id: "enabled",
              label: "Automatic notifications",
              currentValue: inherited("enabled") ? "Inherit" : (own.enabled ?? true) ? "On" : "Off",
              values: scope === "project" ? ["Inherit", "On", "Off"] : ["Off", "On"],
              action: "policy",
              description: `Send to selected destinations when Pi stops automatic work. Off still allows manual tests. Effective: ${state.snapshot.effective.enabled ? "On" : "Off"}. Source: ${Object.hasOwn(state.snapshot.project, "enabled") ? "Project" : Object.hasOwn(state.snapshot.user, "enabled") ? "User" : "default"}.`,
            },
            {
              id: "mode",
              label: "Mode",
              currentValue: inherited("mode") ? "Inherit" : String(own.mode ?? "immediate"),
              values:
                scope === "project" ? ["Inherit", "immediate", "after-inactivity"] : ["immediate", "after-inactivity"],
              action: "policy",
              description: `Effective: ${state.snapshot.effective.mode}. Inactivity falls back to immediate outside TUI.`,
            },
            {
              id: "inactivitySeconds",
              label: "Input inactivity time",
              currentValue: `${state.editing.inactivitySeconds}s${inherited("inactivitySeconds") ? " (inherited)" : ""}`,
              disabled: state.editing.mode !== "after-inactivity",
              action: "delay",
              description:
                "Only forwarded input resets this timer. Fullscreen focus, mouse, and viewport/search keys may not reach it.",
            },
            {
              id: "targetIds",
              label: "Send notifications to",
              currentValue: `${state.editing.targetIds.length}${inherited("targetIds") ? " (inherited)" : ""}`,
              action: "target",
              description: "Choose which saved destinations receive notifications.",
            },
          ],
        };
      },
      targets: ({ state }) => ({
        kind: "multiSelect",
        title: `Send notifications to · ${scope}`,
        items: Object.entries(state.snapshot.effective.destinations).map(([id, value]) => ({
          id,
          label: safeText(value.label),
          description: destinationDescription(value),
          selected: state.editing.targetIds.includes(id),
        })),
        action: "target",
        enableSearch: true,
        actions:
          scope === "project"
            ? [{ id: "inherit:targets", label: "Restore inherited selection", action: "inheritTargets" }]
            : [],
      }),
      delay: () => ({
        kind: "choice",
        title: `Input inactivity time · ${scope}`,
        items: [
          ...(scope === "project" ? [{ id: "inherit", label: "Inherit User setting" }] : []),
          { id: "30", label: "30 seconds" },
          { id: "60", label: "1 minute" },
          { id: "120", label: "2 minutes" },
          { id: "custom", label: "Custom seconds…" },
        ],
        action: "delay",
      }),
      customDelay: ({ state }) => ({
        kind: "input",
        title: "Inactivity seconds",
        lines: ["Whole seconds from 1 to 86400."],
        initialValue: String(state.editing.inactivitySeconds),
        action: "customDelay",
      }),
      label: () => ({
        kind: "input",
        title: `${providerLabel(assertDraft())} destination label`,
        initialValue: assertDraft().label,
        action: "label",
      }),
      chat: () => ({
        kind: "input",
        title: "Telegram chat ID",
        lines: ["Numeric private chat, group, or supergroup ID. Group IDs can be negative."],
        initialValue: telegramDraft().chatId,
        action: "chat",
      }),
      topic: () => ({
        kind: "input",
        title: "Forum topic ID (optional)",
        lines: ["Leave empty for no topic."],
        initialValue: String(telegramDraft().messageThreadId ?? ""),
        action: "topic",
      }),
      ntfyTopic: () => ({
        kind: "input",
        title: "ntfy topic",
        lines: ["A topic name is not access control. Configure server authentication and topic permissions."],
        initialValue: ntfyDraft().topic,
        action: "ntfyTopic",
      }),
      serverUrl: () => ({
        kind: "input",
        title: `${providerLabel(serverDraft())} server URL`,
        lines: ["HTTP(S) base URL with an optional reverse-proxy path. No credentials, query, or fragment."],
        initialValue: serverDraft().serverUrl,
        action: "serverUrl",
      }),
      priority: () => ({
        kind: "input",
        title: `${providerLabel(priorityDraft())} priority (optional)`,
        lines: [
          priorityDraft().provider === "ntfy"
            ? "Integer from 1 to 5. Leave empty for the server default."
            : "Safe integer from -9007199254740991 to 9007199254740991. Leave empty for the server default.",
        ],
        initialValue: String(priorityDraft().priority ?? ""),
        action: "priority",
      }),
      review: () => ({
        kind: "actions",
        title: `Review ${providerLabel(assertDraft())} destination · User`,
        lines: [
          ...destinationLines(assertDraft()),
          ...(store.snapshot.effective.destinations[selectedId]
            ? ["Save keeps your current notification selection."]
            : [
                "Use this destination for notifications?",
                "Save and use: save this destination and select it for User notifications.",
                "Save only: save this destination without selecting it.",
              ]),
          "Automatic notifications default to On. Saved Off settings and Project choices are unchanged.",
        ],
        items: [
          {
            id: "save",
            label: store.snapshot.effective.destinations[selectedId] ? "Save changes" : "Save and use",
            action: "save",
          },
          {
            id: "token",
            label: `Replace ${credentialLabels[assertDraft().provider]}…`,
            action: "token",
          },
          ...(assertDraft().provider === "telegram"
            ? [{ id: "chat", label: "Change chat ID…", to: "chat" as const }]
            : []),
          ...(assertDraft().provider === "gotify" ||
          assertDraft().provider === "ntfy" ||
          assertDraft().provider === "bark"
            ? [{ id: "serverUrl", label: "Change server URL…", to: "serverUrl" as const }]
            : []),
          ...(assertDraft().provider === "pushover"
            ? [{ id: "userKey", label: "Replace user key…", action: "userKey" as const }]
            : []),
          ...(assertDraft().provider === "line"
            ? [{ id: "recipientId", label: "Replace recipient ID…", action: "recipientId" as const }]
            : []),
          { id: "label", label: "Change label…", to: "label" },
          ...(assertDraft().provider === "webhook"
            ? [{ id: "bearerToken", label: "Set Bearer token (empty for none)…", action: "bearerToken" as const }]
            : []),
          ...(assertDraft().provider === "telegram"
            ? [{ id: "topic", label: "Set forum topic ID…", to: "topic" as const }]
            : []),
          ...(assertDraft().provider === "ntfy"
            ? [{ id: "ntfyTopic", label: "Change topic…", to: "ntfyTopic" as const }]
            : []),
          ...(assertDraft().provider === "gotify" || assertDraft().provider === "ntfy"
            ? [{ id: "priority", label: "Set priority…", to: "priority" as const }]
            : []),
          ...(!store.snapshot.effective.destinations[selectedId]
            ? [{ id: "saveOnly", label: "Save only", action: "saveOnly" as const }]
            : []),
        ],
      }),
      remove: () => ({
        kind: "actions",
        title: `Remove ${providerLabel(knownDestination())} destination?`,
        lines: [
          safeText(knownDestination().label),
          "Also removes its User selection. Existing messages are not recalled.",
          "Remove any Project selection first.",
        ],
        items: [{ id: "confirm", label: "Remove destination", action: "remove" }],
      }),
      testSelect: ({ state }) => ({
        kind: "actions",
        title: "Test destination · sends externally",
        items: Object.entries(state.snapshot.effective.destinations).map(([id, value]) => ({
          id,
          label: safeText(value.label),
          description: destinationDescription(value),
          action: "prepareTest" as const,
        })),
      }),
      testReview: () => ({
        kind: "review",
        title: `Send test to ${safeText(testDestination?.label ?? "destination")}?`,
        lines: testDestination ? [destinationDescription(testDestination)] : [],
        content: `${testNotification?.title ?? ""}\n${testNotification?.body ?? ""}`,
        viewportSize: "adaptive",
        confirm: {
          id: "send",
          label: `Send test to ${testDestination ? providerLabel(testDestination) : "destination"}`,
          action: "sendTest",
        },
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Notify Status",
        lines: [
          `User: ${displayPath(store.userPath)}`,
          `Project: ${store.projectPath ? displayPath(store.projectPath) : "not trusted / unavailable"}`,
          ...policyKeys.map(
            (key) =>
              `${key}: source ${Object.hasOwn(state.snapshot.project, key) ? "Project" : Object.hasOwn(state.snapshot.user, key) ? "User" : "default"}`,
          ),
          `Pending reminder: ${coordinator.pendingAt ? new Date(coordinator.pendingAt).toISOString() : "none"}`,
          ...Object.entries(state.snapshot.effective.destinations).map(([id, value]) => {
            const result = coordinator.statuses.get(id)?.result;
            return `${safeText(value.label)} · ${destinationDescription(value)} (User) · ${state.snapshot.effective.targetIds.includes(id) ? "selected" : "not selected"} · ${result ? (result.state === "failed" ? `${result.code}${result.retryAfterSeconds ? `; retry after ${result.retryAfterSeconds}s (not automatic)` : ""}` : result.state) : "no delivery"}`;
          }),
          ...state.snapshot.diagnostics,
        ],
      }),
      help: () => ({ kind: "detail", title: "Notify Help", lines: helpLines }),
    },
    actions: {
      scope: ({ value }) => {
        if (value === "Project" && !store.projectPath)
          throw new Error("Trust the project before editing Project settings.");
        scope = value === "Project" ? "project" : "user";
        return { kind: "stay" };
      },
      policy: async ({ itemId, value, signal: actionSignal }) => {
        if (itemId !== "enabled" && itemId !== "mode") throw new Error("Invalid setting.");
        await apply(
          savePolicy(
            store,
            scope,
            itemId,
            value === "Inherit" ? undefined : itemId === "enabled" ? value === "On" : value,
            actionSignal,
          ),
        );
        return { kind: "stay" };
      },
      delay: async ({ itemId, signal: actionSignal }) => {
        if (itemId === "inactivitySeconds") return { kind: "to", screen: "delay" };
        if (itemId === "custom") return { kind: "to", screen: "customDelay" };
        await apply(
          savePolicy(
            store,
            scope,
            "inactivitySeconds",
            itemId === "inherit" ? undefined : Number(itemId),
            actionSignal,
          ),
        );
        return { kind: "back" };
      },
      customDelay: async ({ value, signal: actionSignal }) => {
        if (!value || !/^\d+$/.test(value) || !validSeconds(Number(value)))
          throw new Error("Use whole seconds from 1 to 86400.");
        await apply(savePolicy(store, scope, "inactivitySeconds", Number(value), actionSignal));
        return { kind: "to", screen: "settings" };
      },
      target: async ({ itemId, selected, signal: actionSignal }) => {
        if (itemId === "targetIds") return { kind: "to", screen: "targets" };
        await apply(
          store.change(
            scope,
            (document, project, user) => {
              const edited = resolveSettings(user, scope === "project" ? project : {}, providers).effective;
              const ids = new Set(edited.targetIds);
              if (selected) ids.add(itemId);
              else ids.delete(itemId);
              document.targetIds = [...ids];
            },
            actionSignal,
          ),
        );
        return { kind: "stay" };
      },
      inheritTargets: async ({ signal: actionSignal }) => {
        await apply(savePolicy(store, "project", "targetIds", undefined, actionSignal));
        return { kind: "stay" };
      },
      select: ({ itemId }) => {
        selectedId = itemId.slice("destination:".length);
        return { kind: "to", screen: "destination" };
      },
      add: async ({ signal: actionSignal }) => {
        const result = await runSecretInput(menuCtx, {
          title: "Telegram bot token",
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "closed" && result.reason === "close") return { kind: "close" };
        if (result.kind !== "submitted") return { kind: "stay" };
        selectedId = randomUUID();
        draft = { provider: "telegram", label: "", botToken: result.value.trim(), chatId: "" };
        return { kind: "to", screen: "chat" };
      },
      addGotify: async ({ signal: actionSignal }) => {
        const result = await runSecretInput(menuCtx, {
          title: "Gotify application token",
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "closed" && result.reason === "close") return { kind: "close" };
        if (result.kind !== "submitted") return { kind: "stay" };
        selectedId = randomUUID();
        draft = { provider: "gotify", label: "", appToken: result.value.trim(), serverUrl: "" };
        return { kind: "to", screen: "serverUrl" };
      },
      addSlack: async ({ signal: actionSignal }) => {
        const result = await runSecretInput(menuCtx, {
          title: "Slack webhook URL",
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "closed" && result.reason === "close") return { kind: "close" };
        if (result.kind !== "submitted") return { kind: "stay" };
        const destination = providers.get("slack")?.validate({
          provider: "slack",
          label: "Slack notifications",
          webhookUrl: result.value,
        });
        if (destination?.provider !== "slack") throw new Error("Use a valid Slack Incoming Webhook URL.");
        selectedId = randomUUID();
        draft = destination;
        return { kind: "to", screen: "review" };
      },
      addLine: async ({ signal: actionSignal }) => {
        const token = await runSecretInput(menuCtx, {
          title: "LINE channel access token",
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (token.kind === "closed" && token.reason === "close") return { kind: "close" };
        if (token.kind !== "submitted") return { kind: "stay" };
        const recipient = await runSecretInput(menuCtx, {
          title: "LINE recipient ID (user, group, or room)",
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (recipient.kind === "closed" && recipient.reason === "close") return { kind: "close" };
        if (recipient.kind !== "submitted") return { kind: "stay" };
        const destination = providers.get("line")?.validate({
          provider: "line",
          label: "LINE notifications",
          channelAccessToken: token.value.trim(),
          recipientId: recipient.value.trim(),
        });
        if (!destination) throw new Error("Use a valid LINE token and recipient ID.");
        selectedId = randomUUID();
        draft = destination;
        return { kind: "to", screen: "review" };
      },
      recipientId: async ({ signal: actionSignal }) => {
        const result = await runSecretInput(menuCtx, {
          title: "Replace LINE recipient ID",
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "closed" && result.reason === "close") return { kind: "close" };
        if (result.kind === "submitted") {
          const destination = assertDraft();
          const valid = providers.get("line")?.validate({ ...destination, recipientId: result.value.trim() });
          if (destination.provider !== "line" || valid?.provider !== "line")
            throw new Error("Use a valid LINE user, group, or room ID.");
          destination.recipientId = valid.recipientId;
        }
        return { kind: "stay" };
      },
      addDiscord: ({ signal: actionSignal }) => addWebhook("discord", actionSignal),
      addWebhook: ({ signal: actionSignal }) => addWebhook("webhook", actionSignal),
      addTeams: ({ signal: actionSignal }) => addWebhook("teams", actionSignal),
      addBark: async ({ signal: actionSignal }) => {
        const result = await runSecretInput(menuCtx, {
          title: "Bark device key",
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "closed" && result.reason === "close") return { kind: "close" };
        if (result.kind !== "submitted") return { kind: "stay" };
        const destination = providers.get("bark")?.validate({
          provider: "bark",
          label: "Bark notifications",
          serverUrl: "https://api.day.app",
          deviceKey: result.value.trim(),
        });
        if (!destination) throw new Error("Use a valid Bark device key.");
        selectedId = randomUUID();
        draft = destination;
        return { kind: "to", screen: "review" };
      },
      addPushover: async ({ signal: actionSignal }) => {
        const app = await runSecretInput(menuCtx, {
          title: "Pushover application token",
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (app.kind === "closed" && app.reason === "close") return { kind: "close" };
        if (app.kind !== "submitted") return { kind: "stay" };
        const user = await runSecretInput(menuCtx, {
          title: "Pushover user key",
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (user.kind === "closed" && user.reason === "close") return { kind: "close" };
        if (user.kind !== "submitted") return { kind: "stay" };
        const destination = providers.get("pushover")?.validate({
          provider: "pushover",
          label: "Pushover notifications",
          appToken: app.value.trim(),
          userKey: user.value.trim(),
        });
        if (!destination) throw new Error("Use a valid application token and user key.");
        selectedId = randomUUID();
        draft = destination;
        return { kind: "to", screen: "review" };
      },
      userKey: async ({ signal: actionSignal }) => {
        const result = await runSecretInput(menuCtx, {
          title: "Replace Pushover user key",
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "closed" && result.reason === "close") return { kind: "close" };
        if (result.kind === "submitted") {
          const destination = assertDraft();
          const valid = providers.get("pushover")?.validate({ ...destination, userKey: result.value.trim() });
          if (destination.provider !== "pushover" || valid?.provider !== "pushover")
            throw new Error("Use a valid user key.");
          destination.userKey = valid.userKey;
        }
        return { kind: "stay" };
      },
      bearerToken: async ({ signal: actionSignal }) => {
        const result = await runSecretInput(menuCtx, {
          title: "Bearer token (empty for none)",
          required: false,
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "closed" && result.reason === "close") return { kind: "close" };
        if (result.kind === "submitted") {
          const destination = assertDraft();
          const valid = providers
            .get("webhook")
            ?.validate({ ...destination, bearerToken: result.value.trim() || undefined });
          if (destination.provider !== "webhook" || valid?.provider !== "webhook")
            throw new Error("Use a valid Bearer token or leave it empty.");
          destination.bearerToken = valid.bearerToken;
        }
        return { kind: "stay" };
      },
      addNtfy: () => {
        selectedId = randomUUID();
        draft = { provider: "ntfy", label: "ntfy notifications", serverUrl: "https://ntfy.sh", topic: "" };
        return { kind: "to", screen: "ntfyTopic" };
      },
      ntfyTopic: ({ value }) => {
        const destination = assertDraft();
        const valid = providers.get("ntfy")?.validate({ ...destination, topic: value?.trim() });
        if (destination.provider !== "ntfy" || valid?.provider !== "ntfy") throw new Error("Use a valid ntfy topic.");
        destination.topic = valid.topic;
        return { kind: "to", screen: "review" };
      },
      edit: () => {
        draft = { ...knownDestination() };
        return { kind: "to", screen: "review" };
      },
      token: async ({ signal: actionSignal }) => {
        const result = await runSecretInput(menuCtx, {
          title: `Replace ${providerLabel(assertDraft())} ${credentialLabels[assertDraft().provider]}`,
          required: assertDraft().provider !== "ntfy",
          signal: actionSignal,
          isCurrent,
          onError: reportError,
        });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "submitted") {
          const destination = assertDraft();
          switch (destination.provider) {
            case "telegram":
              destination.botToken = result.value.trim();
              break;
            case "gotify":
              destination.appToken = result.value.trim();
              break;
            case "pushover": {
              const valid = providers.get("pushover")?.validate({ ...destination, appToken: result.value.trim() });
              if (valid?.provider !== "pushover") throw new Error("Use a valid application token.");
              destination.appToken = valid.appToken;
              break;
            }
            case "bark": {
              const valid = providers.get("bark")?.validate({ ...destination, deviceKey: result.value.trim() });
              if (valid?.provider !== "bark") throw new Error("Use a valid device key.");
              destination.deviceKey = valid.deviceKey;
              break;
            }
            case "line": {
              const valid = providers
                .get("line")
                ?.validate({ ...destination, channelAccessToken: result.value.trim() });
              if (valid?.provider !== "line") throw new Error("Use a valid LINE channel access token.");
              destination.channelAccessToken = valid.channelAccessToken;
              break;
            }
            case "teams":
            case "discord":
            case "webhook": {
              const valid = providers.get(destination.provider)?.validate({ ...destination, webhookUrl: result.value });
              if (valid?.provider !== destination.provider) throw new Error("Use a valid webhook URL.");
              destination.webhookUrl = valid.webhookUrl;
              break;
            }
            case "ntfy": {
              const valid = providers
                .get("ntfy")
                ?.validate({ ...destination, accessToken: result.value.trim() || undefined });
              if (valid?.provider !== "ntfy") throw new Error("Use a valid access token or leave it empty.");
              destination.accessToken = valid.accessToken;
              break;
            }
            case "slack": {
              const valid = providers.get("slack")?.validate({ ...destination, webhookUrl: result.value });
              if (valid?.provider !== "slack") throw new Error("Use a valid Slack Incoming Webhook URL.");
              destination.webhookUrl = valid.webhookUrl;
              break;
            }
          }
        }
        if (result.kind === "closed" && result.reason === "close") return { kind: "close" };
        return { kind: "stay" };
      },
      label: ({ value }) => {
        if (!value?.trim() || value.length > 128) throw new Error("Use a label from 1 to 128 characters.");
        assertDraft().label = value.trim();
        return { kind: "to", screen: "review" };
      },
      chat: ({ value }) => {
        if (!value || !/^-?[1-9]\d{0,30}$/.test(value.trim())) throw new Error("Use a numeric Telegram chat ID.");
        const destination = telegramDraft();
        destination.chatId = value.trim();
        if (!destination.label) destination.label = `Telegram ${destination.chatId}`;
        return { kind: "to", screen: "review" };
      },
      topic: ({ value }) => {
        const topic = value?.trim();
        if (topic && (!/^\d+$/.test(topic) || !Number.isSafeInteger(Number(topic)) || Number(topic) <= 0))
          throw new Error("Use a positive whole topic ID or leave it empty.");
        if (topic) telegramDraft().messageThreadId = Number(topic);
        else delete telegramDraft().messageThreadId;
        return { kind: "to", screen: "review" };
      },
      serverUrl: ({ value }) => {
        const destination = serverDraft();
        const normalized = providers.get(destination.provider)?.validate({
          ...destination,
          label: destination.label || "Gotify",
          serverUrl: value?.trim(),
        });
        if (
          !normalized ||
          (normalized.provider !== "gotify" && normalized.provider !== "ntfy" && normalized.provider !== "bark")
        )
          throw new Error("Use a valid server URL and credentials. No URL credentials, query, or fragment.");
        destination.serverUrl = normalized.serverUrl;
        if (!destination.label) destination.label = `Gotify ${displayServerUrl(destination.serverUrl)}`.slice(0, 128);
        return { kind: "to", screen: "review" };
      },
      priority: ({ value }) => {
        const priority = value?.trim();
        if (priority && (!/^-?\d+$/.test(priority) || !Number.isSafeInteger(Number(priority))))
          throw new Error("Use a safe-integer priority or leave it empty.");
        const destination = priorityDraft();
        if (priority && destination.provider === "ntfy" && (Number(priority) < 1 || Number(priority) > 5))
          throw new Error("Use a priority from 1 to 5.");
        if (priority) destination.priority = Number(priority);
        else delete destination.priority;
        return { kind: "to", screen: "review" };
      },
      save: ({ signal: actionSignal }) => saveDraft(actionSignal, true),
      saveOnly: ({ signal: actionSignal }) => saveDraft(actionSignal, false),
      remove: async ({ signal: actionSignal }) => {
        await apply(saveDestination(store, selectedId, undefined, actionSignal));
        return { kind: "to", screen: "main" };
      },
      prepareTest: async ({ itemId, signal: actionSignal }) => {
        selectedId = itemId;
        testDestination = { ...knownDestination() };
        const now = Date.now();
        const notification = await notificationMetadata(
          {
            id: `test-${randomUUID()}`,
            sessionId: ctx.sessionManager.getSessionId(),
            sessionName: ctx.sessionManager.getSessionName(),
            cwd: ctx.cwd,
            startedAt: now,
            settledAt: now,
            error: false,
          },
          actionSignal,
        );
        actionSignal.throwIfAborted();
        current();
        testNotification = { ...notification, title: "Pi notification test" };
        return { kind: "to", screen: "testReview" };
      },
      sendTest: async ({ signal: actionSignal }) => {
        current();
        if (!testDestination || !testNotification) throw new Error("Prepare a new test.");
        const destination = testDestination;
        const notification = testNotification;
        const result = await runTask(menuCtx, {
          label: `Sending ${providerLabel(destination)} test…`,
          signal: actionSignal,
          isCurrent,
          onError: reportError,
          task: ({ signal: taskSignal }) => coordinator.send(selectedId, destination, notification, taskSignal),
        });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "completed")
          ctx.ui.notify(
            result.value.state === "accepted"
              ? `${providerLabel(destination)} accepted the test notification.`
              : `${providerLabel(destination)} test: ${result.value.state === "failed" ? result.value.code : result.value.state}.`,
            result.value.state === "accepted" ? "info" : "warning",
          );
        if (result.kind === "cancelled") return { kind: "close" };
        return { kind: "to", screen: "main" };
      },
    },
  });
  try {
    return await runMenu(menuCtx, menu, {
      signal,
      isCurrent,
      getState: () => ({
        snapshot: store.snapshot,
        editing: resolveSettings(store.snapshot.user, scope === "project" ? store.snapshot.project : {}, providers)
          .effective,
      }),
      onError: reportError,
    });
  } finally {
    draft = undefined;
    testDestination = undefined;
    testNotification = undefined;
  }
}
