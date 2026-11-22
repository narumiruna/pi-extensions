import { generateUnifiedPatch, type Theme } from "@earendil-works/pi-coding-agent";
import { hardWrapTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";

export function getDraftChanges(previous: string, current: string): string[] | undefined {
  const rows = generateUnifiedPatch("plan.md", previous, current, 3).split("\n").slice(2, -1);
  return rows.length > 0 ? rows : undefined;
}

export function renderDraftChanges(rows: readonly string[], width: number, theme: Pick<Theme, "fg">): string[] {
  if (width < 1) return [];
  return rows.flatMap((row) => {
    const role = row.startsWith("+") ? "toolDiffAdded" : row.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext";
    return hardWrapTerminalDocument(row, width).map((line) => theme.fg(role, line));
  });
}
