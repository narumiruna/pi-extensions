import { sanitizeTerminalDocument } from "../terminal-document.js";

export function sanitizeDocumentText(value: unknown): string {
  return sanitizeTerminalDocument(String(value));
}
