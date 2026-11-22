import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { safeTerminalText } from "./terminal-text.js";

export function manualIgnoreFileGuidance(filename: string) {
  return `Edit existing ignore rules manually: ${safeTerminalText(resolve(getAgentDir(), filename))}. Edits apply to every setup using this local file on its next sync; they do not rewrite remote history.`;
}
