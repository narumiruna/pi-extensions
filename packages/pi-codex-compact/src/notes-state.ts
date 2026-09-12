import { stripVTControlCharacters } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const NOTES_ENTRY_TYPE = "pi-codex-context-note";
export const NOTES_VERSION = 1;
export const MAX_NOTE_NAME_LENGTH = 128;
export const MAX_NOTE_MUTATION_BYTES = 16 * 1024;
export const MAX_NOTE_COUNT = 64;
export const MAX_NOTES_BYTES = 256 * 1024;

export type NoteAction = "write" | "append";

export interface NoteMutation {
  version: typeof NOTES_VERSION;
  action: NoteAction;
  note: string;
  content: string;
}

export interface ContextNote {
  name: string;
  content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validNoteName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_NOTE_NAME_LENGTH &&
    value.trim() === value &&
    stripVTControlCharacters(value) === value &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
    })
  );
}

export function parseNoteMutation(value: unknown): NoteMutation | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== NOTES_VERSION ||
    (value.action !== "write" && value.action !== "append") ||
    !validNoteName(value.note) ||
    typeof value.content !== "string" ||
    value.content.length === 0 ||
    bytes(value.content) > MAX_NOTE_MUTATION_BYTES
  ) {
    return undefined;
  }
  return {
    version: NOTES_VERSION,
    action: value.action,
    note: value.note,
    content: value.content,
  };
}

export function loadNotes(entries: readonly SessionEntry[]): Map<string, string> {
  const notes = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== NOTES_ENTRY_TYPE) continue;
    const mutation = parseNoteMutation(entry.data);
    if (!mutation) continue;
    const previous = notes.get(mutation.note);
    const next = mutation.action === "append" ? `${previous ?? ""}${mutation.content}` : mutation.content;
    notes.set(mutation.note, next);
    if (notes.size > MAX_NOTE_COUNT || totalNotesBytes(notes) > MAX_NOTES_BYTES) {
      if (previous === undefined) notes.delete(mutation.note);
      else notes.set(mutation.note, previous);
    }
  }
  return notes;
}

function totalNotesBytes(notes: ReadonlyMap<string, string>): number {
  let total = 0;
  for (const [name, content] of notes) total += bytes(name) + bytes(content);
  return total;
}

export function createNoteMutation(
  entries: readonly SessionEntry[],
  input: { action: NoteAction; note: string; content: string },
): { mutation: NoteMutation; notes: Map<string, string> } {
  const mutation = parseNoteMutation({ version: NOTES_VERSION, ...input });
  if (!mutation) {
    throw new Error(
      `Invalid note mutation; names must be 1-${MAX_NOTE_NAME_LENGTH} characters without terminal controls and content must be 1-${MAX_NOTE_MUTATION_BYTES} UTF-8 bytes`,
    );
  }
  const notes = loadNotes(entries);
  const exists = notes.has(mutation.note);
  const next = mutation.action === "append" ? `${notes.get(mutation.note) ?? ""}${mutation.content}` : mutation.content;
  if (!exists && notes.size >= MAX_NOTE_COUNT) {
    throw new Error(`Context notes are limited to ${MAX_NOTE_COUNT} names`);
  }
  notes.set(mutation.note, next);
  if (totalNotesBytes(notes) > MAX_NOTES_BYTES) {
    throw new Error(`Context notes exceed the ${MAX_NOTES_BYTES}-byte active-state limit`);
  }
  return { mutation, notes };
}

export function sortedNotes(entries: readonly SessionEntry[]): ContextNote[] {
  return [...loadNotes(entries)]
    .map(([name, content]) => ({ name, content }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
