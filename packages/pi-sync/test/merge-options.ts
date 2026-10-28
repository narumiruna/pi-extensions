import type { CommandOptions } from "../src/commands/command-types.js";

// Shared input only: consumers override fields with an object spread, never mutate this fixture.
export const mergeOptions: CommandOptions = {
  args: [],
  yes: true,
  force: false,
  stale: false,
  silent: false,
  reload: false,
  auto: false,
};
