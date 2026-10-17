# Notify settings and behavior

Use `/notify` for setup or edit the canonical user JSON file. Settings load on session start, including reload and session replacement. Reads do not create files. Successful menu saves apply immediately; manual file edits need `/reload` or another session start.

## Fields and scope

| Field | Accepted values | Default | Scope |
| --- | --- | --- | --- |
| `enabled` | Boolean | `true` | User or trusted Project |
| `mode` | `immediate`, `after-inactivity` | `immediate` | User or trusted Project |
| `inactivitySeconds` | Whole number from 1 to 86400 | `30` | User or trusted Project |
| `targetIds` | Array of unique existing destination IDs, at most 32 | Empty | User or trusted Project |
| `destinations` | Object keyed by stable IDs, at most 32 | Empty | User only |

Destination IDs contain 1–64 ASCII letters, digits, underscores, or hyphens, starting with a letter or digit; `constructor`, `prototype`, and `__proto__` are reserved. The menu creates IDs automatically.

Telegram setup requires a bot token and chat ID; Gotify setup requires an application token and server URL. The menu generates a label and opens a review for edits before saving. Editing an existing destination opens the same review with its current values. Destination changes take effect only after confirmation. For a new destination, Save and use adds it to User `targetIds` in the same atomic save; Save only stores it without selecting it. Editing an existing destination preserves its selection state. Explicit Project selections and saved `enabled: false` values are unchanged. Automatic notifications default to On; Off pauses automatic delivery but still allows manual tests. No delivery occurs without a selected destination.

Each Telegram destination has `provider: "telegram"`, a nonempty `label` of at most 128 characters, `botToken`, a numeric string `chatId`, and optional positive safe-integer `messageThreadId`. A group or supergroup ID can be negative. Store IDs as strings, not JSON numbers. Forum topic IDs use Telegram's `message_thread_id` field. Other Telegram chat products with additional required fields are not supported.

Each Gotify destination has `provider: "gotify"`, a nonempty `label` of at most 128 characters, `serverUrl`, `appToken`, and optional `priority`. Use an application token created in the server's Apps tab, not a client token or password. Tokens must contain 1–512 printable ASCII characters without spaces. Server URLs must be absolute HTTP(S) URLs, at most 2048 characters before and after URL normalization, without whitespace, control characters, backslashes, credentials, query strings, or fragments. Include any reverse-proxy base path; do not append `/message`. Trailing slashes are removed on save. HTTP is supported for self-hosted deployments but does not encrypt credentials or metadata; prefer HTTPS. Priority must be a safe integer (including zero or negative values). Leave it unset to use the application's default priority; clear the field in review to restore that default.

```json
{
  "targetIds": ["gotify"],
  "destinations": {
    "gotify": {
      "provider": "gotify",
      "label": "Personal Gotify",
      "serverUrl": "https://push.example.com/gotify",
      "appToken": "<application-token>",
      "priority": 5
    }
  }
}
```

Gotify and Telegram destinations can share the same `destinations` object and `targetIds` selection. Saved destinations keep their provider; create a new destination to change providers.

Resolve defaults, User fields, then trusted Project overrides. Project arrays replace rather than merge. Project files cannot define destinations or credentials. Unknown provider IDs do not fall back to Telegram. Invalid fields, unreadable files, unsupported destinations, or missing selected IDs produce diagnostics and disable automatic delivery until repaired; no partial routing is attempted.

Project Settings show inherited values and allow restoring inheritance. Removing a destination clears its User selection atomically, but is blocked if the current trusted Project explicitly selects it. Change that Project selection first. Other projects are not edited; repair their selected IDs before enabling notifications there.

## Persistence and recovery

Settings operations are ordered within the process, including across store instances for the same user path. Reads wait for pending writes. This is not a cross-process lock: simultaneous menu edits in different Pi processes can conflict.

Writes read the latest valid document, preserve unrelated fields and destination fields, and publish using a same-directory temporary file plus rename. Unknown provider data is retained during unrelated edits. Malformed JSON blocks writes instead of being overwritten with defaults. An existing non-object `destinations` value blocks destination changes. A non-object destination entry cannot be replaced with a new object. Repair these stored structures first; destination setup does not coerce them to empty defaults. A failed save keeps the previous file and effective state; the menu restores the previous displayed setting. A failed operation does not poison subsequent operations. Reload and shutdown await queued settings operations.

If a file is malformed, repair it manually before saving. Disable notifications in every effective scope to stop new attempts and cancel pending reminders. Unloading the extension aborts owned delivery work, but cannot recall accepted messages. Revoke exposed tokens before replacing them in User settings.

## Inactivity timing

The activity baseline starts when the session and input observer start. It measures only input forwarded by Pi through `ctx.ui.onTerminalInput()`. Keyboard input and paste count when they reach this hook. Clicks, wheel events, and focus-gain reports also count if forwarded. Key releases, mouse motion, terminal capability replies, and focus loss do not. Unknown terminal reports are ignored; unsupported terminal keyboard encodings may therefore not count as activity.

In fullscreen mode, Pi registers its viewport listener before extension listeners. It consumes focus events, mouse events, and viewport/search keys. Wheel events can also be consumed, although a focused overlay can cause Pi to forward them. Thus returning to the window, clicking, scrolling, or using a viewport key does not reliably cancel a reminder. In regular mode, more of these events can reach the hook, but delivery still depends on earlier listeners and terminal support. The public API has no observer priority or pre-consumption hook. The extension does not read raw stdin or reorder host listeners.

For a 30-second threshold, settlement after 10 seconds without input waits another 20 seconds. Settlement after 40 seconds without input starts delivery immediately. The timestamp in the message remains the settlement time.

Observed input during the wait cancels that reminder rather than restarting its timer. New work also cancels the pending reminder; the next settlement is evaluated separately. Settings/destination changes cancel pending reminders and apply to subsequent work periods. The duration row is inactive in immediate mode. Focus reporting is optional and never enabled by the extension. A continuously focused window does not suppress reminders.

RPC, print, and JSON use immediate settlement delivery because their client activity is not observable through terminal input. This fallback does not guarantee delivery before a short-lived process exits.

## Work periods and delivery

The coordinator observes `before_agent_start`, with `agent_start` as a fallback, and sends only at `agent_settled`. Low-level retries and continuations preserve the initial work-period start time. The final assistant stop reason identifies a terminal error without forwarding its body. An aborted settlement always suppresses notification, even if an earlier assistant error remains. Load/reload never replays past results.

Metadata is collected at settlement through bounded Git subprocesses. Missing Git information is omitted. Pending metadata work is cancelled with its reminder. Once a delivery attempt starts, new user work does not cancel it; session replacement, reload, shutdown, or explicit test cancellation does. Late results cannot replace newer per-destination status. Test delivery bypasses automatic enablement and inactivity, requires explicit confirmation, and never changes automatic arming or history.

The provider contract validates destinations and sends a provider-neutral notification with a cancellation signal. Providers do not read sessions, change settings, schedule timers, or decide notification policy. The built-in provider map contains Telegram and Gotify. Transport results distinguish accepted, failed with a safe code, and cancelled; retry-after is diagnostic, not an automatic retry instruction.

Both transports reject redirects, use a 10-second timeout, make one attempt, and cap success response reads at 65536 bytes. Errors expose only fixed codes, never tokens, request URLs, response bodies, or raw transport exceptions.

Telegram requests use its fixed HTTPS origin and do not enable paid broadcasts. Text is clipped to at most 4096 UTF-16 code units without splitting a Unicode code point. Telegram's JSON `ok` field and HTTP status are both checked.

Gotify posts JSON to `<serverUrl>/message` with `X-Gotify-Key` application-token authentication. The title and body are separate fields; emphasis metadata is not sent, and Markdown extras are not enabled. An unset priority is omitted so the server uses the application's default. A successful HTTP response must contain a message with positive integer `id` and `appid`, string `message`, and valid `date`. HTTP failures use a safe `http` code; HTTP 429 uses `rate-limit` and includes a positive integer `Retry-After` value when available. Server response text is never displayed.

## Authoritative references

- [Telegram BotFather setup](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).
- [Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage): chat IDs, forum topics, text limits, and link previews.
- [Telegram getUpdates](https://core.telegram.org/bots/api#getupdates): manual chat-ID discovery; incompatible with active webhooks.
- [Telegram ResponseParameters](https://core.telegram.org/bots/api#responseparameters): `retry_after` on flood control.
- [Telegram rate limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this): avoid more than one message per second in a chat, 20 per minute in a group, and about 30 per second across free broadcasts.
- [Gotify push messages](https://gotify.net/docs/pushmsg): application setup and application-token authentication.
- [Gotify API](https://gotify.net/api-docs) and [server API specification](https://raw.githubusercontent.com/gotify/server/v3.1.1/docs/spec.json): `POST /message`, message fields, and response schema.
- [Pi extension lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#agent_start--agent_end--agent_before_settle--agent_settled).

Input classification follows the installed Pi `ProcessTerminal` and `StdinBuffer` sequence splitting, Pi's `parseKey`/`isKeyRelease`, and `TuiAltScreen` SGR mouse handling. Pure classifier tests cover keyboard, Unicode, paste, focus, press/release, motion, wheel, legacy mouse, CSI/OSC/DCS/APC replies, and unknown input. These tests do not prove that an event reaches the extension. Installed-runtime tests also pass events through real regular/fullscreen Pi renderers and check listener order, viewport keys, and focused-overlay branches. Physical terminal and multiplexer behavior remains unverified.
