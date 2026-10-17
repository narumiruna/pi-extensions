import { createGotifyProvider } from "./gotify.js";
import type { Providers } from "./provider.js";
import { createTelegramProvider } from "./telegram.js";

export const providers: Providers = new Map([
  ["telegram", createTelegramProvider()],
  ["gotify", createGotifyProvider()],
]);
