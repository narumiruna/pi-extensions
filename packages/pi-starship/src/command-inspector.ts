import { stripVTControlCharacters } from "node:util";
import type { StatuslineInspection } from "./modules/inspection.js";

export function formatFooterExplanation(inspection: StatuslineInspection | undefined): string {
  if (!inspection) {
    return safeLines([
      "Footer inspection is unavailable until the TUI footer is ready.",
      "No collection work was started.",
    ]);
  }
  if (inspection.showing.length === 0) {
    return safeLines([
      "No modules are currently showing.",
      "Open Modules to inspect empty, disabled, or unreachable modules.",
    ]);
  }
  return safeLines(
    inspection.showing.flatMap((module, index) => [
      ...(index > 0 ? [""] : []),
      module.name,
      ...previewLines(module.preview),
      module.description,
    ]),
  );
}

function previewLines(preview: string): string[] {
  const lines = preview ? preview.split("\n") : ["(no text)"];
  return lines.map((line, index) => `${index === 0 ? "Value: " : "       "}${line}`);
}

function safeLines(lines: readonly string[]): string {
  return lines.map(safeDisplayText).join("\n");
}

function safeDisplayText(value: string): string {
  return Array.from(stripVTControlCharacters(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? "" : character;
  }).join("");
}
