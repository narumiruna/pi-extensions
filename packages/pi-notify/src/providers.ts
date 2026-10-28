import type { Providers } from "./provider.js";
import { createBarkProvider } from "./providers/bark.js";
import { createDiscordProvider } from "./providers/discord.js";
import { createGotifyProvider } from "./providers/gotify.js";
import { createLineProvider } from "./providers/line.js";
import { createNtfyProvider } from "./providers/ntfy.js";
import { createPushoverProvider } from "./providers/pushover.js";
import { createSlackProvider } from "./providers/slack.js";
import { createTeamsProvider } from "./providers/teams.js";
import { createTelegramProvider } from "./providers/telegram.js";
import { createWebhookProvider } from "./providers/webhook.js";

export const providers: Providers = new Map([
  ["telegram", createTelegramProvider()],
  ["gotify", createGotifyProvider()],
  ["slack", createSlackProvider()],
  ["ntfy", createNtfyProvider()],
  ["pushover", createPushoverProvider()],
  ["discord", createDiscordProvider()],
  ["bark", createBarkProvider()],
  ["webhook", createWebhookProvider()],
  ["line", createLineProvider()],
  ["teams", createTeamsProvider()],
]);
