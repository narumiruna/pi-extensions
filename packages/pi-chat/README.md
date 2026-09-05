# 💬 Pi Chat — Talk to Peers Without Leaving Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-chat)](https://www.npmjs.com/package/@narumitw/pi-chat) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Join ephemeral peer-to-peer chat rooms without leaving Pi.
Chat messages stay out of prompts, model context, repositories, and agent output.
Pi Chat is not an anonymous or reliable messaging service.
Pi Chat uses Hyperswarm and HyperDHT for peer discovery and encrypted Noise streams for direct connections.

## ✨ Features

- Creates private rooms with bearer invites and joins discoverable public rooms by slug.
- Shows stable public-key fingerprints beside nicknames for identity checks.
- Keeps chat in a dedicated composer and dock beside the normal Pi editor.
- Preserves drafts and can restore a remembered room and the last selected surface.
- Signs and relays bounded events over authenticated, encrypted peer connections.
- Stores identity settings privately and releases networking and UI resources on leave or shutdown.

## 📦 Install

Install persistently:

```bash
pi install npm:@narumitw/pi-chat
```

Run once from npm:

```bash
pi -e npm:@narumitw/pi-chat
```

Build and run a local checkout:

```bash
npm --workspace @narumitw/pi-chat run build
pi --no-extensions --no-skills --no-session -e ./packages/pi-chat
```

The package declares `dist/index.ts`, so an unbuilt local checkout must be built before Pi loads the package directory.

Load the package only once in each Pi process.
Repeating `-e ./packages/pi-chat` creates duplicate instances and suffixed commands such as `/chat:1` and `/chat:2`.

Pi extensions execute with your user permissions.
Review source before installing third-party packages.

## 🚀 Quick start

Run `/chat`, choose a public or private room, confirm a nickname, and start chatting.
Press `Escape` or `Ctrl+C` to return to the Pi editor while staying in the room and keeping the draft.

## 🧭 Rooms and composer

The `/chat` menu offers these entry actions:

- **Browse public rooms** queries a best-effort P2P directory, sorts discovered rooms by estimated active participants and then slug, and keeps Refresh plus manual slug entry available.
- **Join public room** accepts a lowercase slug such as `pi-dev`, remembers it after the public-room warning is confirmed, and opens the chat composer.
- **Join with invite** accepts a private-room invite, then offers **Join and remember**, **Join once**, or **Cancel** before networking starts.
- **Create private room** generates a random `pichat:v2:…` bearer invite and uses the same explicit persistence choice.
  Existing `pichat:v1` invites remain accepted and map to v2 rooms.

The first join asks for a nickname and joined-room display mode, then previews the generated identity fingerprint and display choice before one atomic save.
Pi Chat does not read your OS username, Git identity, cwd, repository, or Pi session to fill these values.
Cancelling creates neither identity settings nor network activity.

A remembered join stores the room and `chat` surface atomically.
On the next Pi start, Pi Chat reconnects and opens the full composer without another command.
If you press Escape or Ctrl+C to return to Pi, it remembers the `pi` surface instead.
The next start then reconnects in the background and keeps the Pi editor focused.

While connected, `/chat` opens the state-aware manager.
**Open chat in <room>** is selected first, followed by participants, private invite, settings, status, help, and **Leave and forget room** last.
The persistent dock continues showing room state while the normal Pi editor targets Pi/LLM.

Inside the dedicated chat composer:

- The header says `CHAT INPUT → <room>` so the destination is never color-only.
- `Enter` sends the current message.
- Pi's configured newline key inserts a newline in the composer.
- `PageUp` and `PageDown` scroll transcript history.
- `Escape` or `Ctrl+C` returns to Pi/LLM without leaving the room or discarding the chat draft.

The composer retains the draft when no authenticated direct neighbor is available or a relay reaches zero neighbors.
A successful local send reports how many direct neighbors accepted the first relay, not room-wide delivery.
Signed events may arrive over multiple paths, but each client displays and forwards one `originPublicKey:eventId` only once while it remains in the bounded deduplication window.
Pi Chat never claims exactly-once delivery, delivery receipts, or offline retry.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/chat` | Create, join, resume, or manage a chat room. |
| `/chat <pichat:v1-or-v2:invite>` | Choose private-room persistence, join, and open chat. |
| `/chat #<public-slug>` | Review the public-room warning, join, and open chat. |

All routes require TUI mode; RPC, print, and JSON modes reject them before networking starts.
Unknown and trailing arguments are rejected.
Escape or Ctrl+C returns to Pi without leaving the room or discarding the draft.
Read [Security and privacy](#-security-and-privacy) before sharing messages or invites.

## 🪪 Identity and nicknames

The display format is:

```text
nickname~7K2P-9D4M-HQ3T
```

The nickname is editable.
The 12-character identity tag is the first 60 bits of the SHA-256 digest of the authenticated DHT public key, encoded with Crockford Base32 and grouped `4-4-4`.
The complete public key remains the protocol identity.
If short tags collide in one room, the UI can extend them.
The short tag is never an authorization boundary.

A fingerprint establishes continuity for one pseudonymous key.
It does **not** prove a person's real-world identity, prevent a user from creating many identities, or recover trust after the local identity is reset or lost.

Nicknames are NFKC-normalized, trimmed, and limited to 24 grapheme clusters.
Terminal, C0/C1, and bidirectional control characters are rejected.
Remote display text is sanitized again before wrapping or rendering.

## ⚙️ Settings

Pi Chat uses this user-owned file:

```text
<getAgentDir()>/pi-chat.json
```

The usual location is `~/.pi/agent/pi-chat.json`.
Pi Chat does not add environment variables or read project-local settings because the identity material is user-owned and secret.

Example with a remembered public room:

```json
{
  "nickname": "Mika",
  "identitySeed": "base64url-encoded-private-seed",
  "widgetMode": "count",
  "resume": {
    "rooms": [
      {
        "id": "derived-room-id",
        "kind": "public",
        "slug": "pi-dev"
      }
    ],
    "activeRoomId": "derived-room-id",
    "surface": "chat"
  }
}
```

`resume.rooms` is a bounded catalog designed to permit future multi-room expansion.
This release connects only `activeRoomId`.
`surface` is `chat` when the user last kept the composer open and `pi` after an intentional return to Pi/LLM.
Transcripts, drafts, peers, and unread counts are never stored.

`widgetMode` accepts:

- `dock`: room and input-target status plus up to three recent messages, adapting to terminal height.
- `latest`: the existing single-message preview.
- `count`: room, direct-peer, and unread status only, without message text.
- `off`: hides the persistent widget.

New identities choose a mode before confirmation, with **Room dock** listed first.
Existing settings retain their stored mode; an older document without `widgetMode` continues to default to `count`, so an upgrade does not expose message text unexpectedly.

Public rooms are remembered only after their existing risk confirmation.
A private room is remembered only when **Join and remember** is selected; this stores its bearer invite in `pi-chat.json`.
**Join once** stores no room material, and Cancel starts neither persistence nor networking.
An older file without `resume` remains disconnected until the next confirmed remembered join.
Stored v1 public or private room ids are normalized to v2 in memory without rewriting the file during load; the next explicit resume save publishes v2 ids while preserving unknown room and resume fields.

The identity seed and stored private invites are redacted from UI, notifications, status, and errors.
On POSIX, settings are published with `0600` permissions.
A missing file is a side-effect-free read.
It is created only after an explicit first-use confirmation or settings change.
Saves are ordered within one Pi process, preserve unknown top-level and nested resume fields, and use a same-directory temporary file plus rename.
Malformed, invalid, symlinked, non-regular, invalid UTF-8, or oversized files fail closed and remain unchanged.

**Reset identity** previews the old and candidate fingerprints and requires confirmation.
Resetting changes your fingerprint everywhere, forgets startup restore, and leaves the active room.

## 🌐 Network and protocol behavior

Pi Chat protocol v2 uses one versioned 32-byte discovery topic per room:

- A private topic and handshake key are domain-separated from a random 32-byte invite secret.
- A public topic is deterministically derived from the public room slug.
- A separate global topic carries only bounded public-room directory presence.

Each peer announces and looks up its topics through HyperDHT.
Hyperswarm establishes authenticated, encrypted Noise streams.
The room handshake binds the room proof, nickname, and both neighbor public keys.
Each client keeps at most **8 direct neighbors** instead of completing a full mesh.

Chat and presence payloads carry the room id, origin public key, event id, issued time, content, and an Ed25519 signature from the origin identity.
A mutable hop budget is decremented at each relay.
After validation, the first copy updates local state and is forwarded to authenticated neighbors other than the ingress connection; later copies with the same `originPublicKey:eventId` are dropped.
Deduplication, rate-limit, participant, and presence state are all bounded and expire locally.

The active-participant catalog supports up to **256 remote identities** and expires presence that has not refreshed for 90 seconds.
This is an approximate local view: sparse-overlay partitions, churn, clock differences, and Sybil identities can change it.
Messages are limited to 4 KiB, protocol frames to 16 KiB, gossip to 8 hops, and the local transcript to 256 entries.

Public-room browsing uses signed room-scoped pseudonyms so honest clients do not expose one stable chat identity across directory rooms.
Directory nodes gossip bounded recent presence and browsers sort unique scoped origins by estimated count descending, then slug ascending.
Results can be empty, stale, or partial; HyperDHT cannot enumerate every unknown topic, so the UI never calls the list or count authoritative.

`pichat:v1` invite text and stored v1 secrets are accepted and mapped to a v2 private room.
Newly created invites use `pichat:v2`.
Protocol-v1 full-mesh clients do not interoperate with the v2 gossip overlay.

Hyperswarm's default DHT depends on public bootstrap infrastructure. “P2P” does not mean infrastructure-free.
NAT, UDP blocking, enterprise firewalls, bootstrap availability, peer churn, or a partitioned sparse overlay can prevent connectivity or delivery.
Pi Chat performs bounded refresh and reconnect work but cannot promise a connection or room-wide delivery.

## 🔒 Security and privacy

- Noise encrypts direct transport, but DHT infrastructure and direct peers may observe IP addresses, timing, and topic participation metadata.
  Pi Chat does not provide anonymity.
- Anyone holding a private invite can join.
  There is no member revocation in the initial protocol.
  Create a new room after an invite leak.
- Public slugs are guessable.
  Anyone may join, record, or repost public-room content.
- A local session mute hides one signed origin while still forwarding valid events so a local preference does not partition the room.
  It does not stop Sybil identities.
- Remote peers can save or copy messages.
  Leaving or clearing the local transcript cannot withdraw copies from their devices.
- Pi Chat never sends cwd, repository data, Git remotes, Pi sessions, prompts, models, files, or agent output unless a user manually types that information into chat.
- Chat messages never call Pi message APIs and never enter model context or the main transcript.
- Deleting `pi-chat.json` loses identity continuity and produces a new fingerprint on the next confirmed join.

### Recovery

If an ordinary join fails, Pi Chat tears down partially opened discovery and sockets and preserves the previous valid settings.
If startup restore fails, the remembered room is kept and `/chat` shows Retry, Join another room, and Forget recovery actions instead of retrying forever.
Invalid settings must be fixed manually before a save can proceed.

Reloading, replacing the Pi session, or shutting down still releases every session-owned network and UI resource.
A new TUI session then restores the remembered room.
Explicit **Leave and forget room** atomically removes resume state before disconnecting; if that save fails, the room stays connected and remembered with an actionable error.

## 🚧 Limitations

The current release intentionally omits:

- simultaneous multi-room connections or UI;
- persistent or synchronized history;
- offline messages, delivery receipts, exactly-once delivery, or global ordering;
- files, images, reactions, replies, editing, or deletion;
- administrator roles, global bans, Sybil resistance, or identity recovery;
- browser, mobile, RPC, print, or JSON chat clients;
- authoritative room enumeration/counts or product-owned relay infrastructure;
- more than 256 tracked remote participants or 8 direct neighbors per client;
- automatic transfer of chat content into the Pi editor, transcript, or model context.

A joined room uses a persistent read-only widget while the normal Pi view is active.
Selecting **Reply in <room>** opens the full chat view instead of a small floating window.
Closing it returns to Pi and the dock without leaving the room.
On short terminals, the dock and composer reduce message rows before hiding room, connectivity, or input-target status.

Pi's public extension widget API does not provide generic mouse hit-testing, so the dock is not clickable and Pi Chat registers no global shortcut.
`/chat` remains the menu-first entrypoint.

## 🧪 Local network smoke

The normal repository test suite mocks Pi Chat's network transports and does not open DHT sockets.
Run the opt-in smoke from a local checkout to exercise real local DHT nodes, sparse relay, retries, process-boundary discovery and delivery, public-room discovery, and resource cleanup:

```bash
npm run smoke:chat-network
```

This smoke is intentionally excluded from `npm test` and CI because local UDP scheduling can be nondeterministic under parallel load.

## 🗂️ Package layout

```text
packages/pi-chat/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── pi-chat.ts                     # Room lifecycle and chat command
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, peer-to-peer chat, P2P developer chat, Hyperswarm, HyperDHT, terminal chat, TypeScript Pi package.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
