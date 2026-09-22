export const NOTES_DIRECTORY = "notes";
export const TEMPLATES_DIRECTORY = "templates";
export const SESSIONS_DIRECTORY = "sessions";

/** Keep a complete note plus tool metadata below Pi's 50 KB model-output ceiling. */
export const MAX_MARKDOWN_BYTES = 45_000;
export const MAX_MARKDOWN_LINES = 1_800;
export const MAX_DISCOVERED_FILES = 1_000;
export const MAX_SCAN_DEPTH = 16;
export const MAX_SCAN_ERRORS = 100;
export const MAX_SESSION_FILES_PER_NOTE = 100;
export const MAX_TRANSCRIPT_MESSAGES = 200;
export const MAX_TRANSCRIPT_CHARS = 50_000;
export const WIDE_WORKSPACE_COLUMNS = 100;

export const CHILD_TOOL_NAMES = [
  "read_current_note",
  "edit_current_note",
  "replace_current_note",
  "rename_current_note",
] as const;

export const NOTES_SYSTEM_PROMPT = `You are the assistant for one Markdown note.

Work only on the current note. Read it before editing. Use edit_current_note for precise changes and replace_current_note only when a full replacement is necessary. New notes may have a temporary untitled filename. Once the note's purpose is clear, proactively use rename_current_note to give it a concise, descriptive relative Markdown path; do not ask the user to choose a filename. Every mutation requires the latest revision returned by read_current_note or a successful mutation. To rename and change content in one response, call rename_current_note first, then at most one content mutation with the same latest revision; renaming preserves that revision and the calls execute in source order. Wait for a successful content mutation's returned revision before issuing another mutation. If a revision is stale, read again before retrying.

You have no access to other notes, templates, sessions, project files, or a shell. Do not claim that you changed content or the filename unless a mutation tool succeeded. Keep the note valid Markdown and preserve unrelated content.`;
