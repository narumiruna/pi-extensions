// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal and display-direction controls.
const TERMINAL_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu;

export function safeTerminalText(value: string) {
  return value.replace(TERMINAL_CONTROLS, "?");
}

/** Escape before joining a multiline review; raw filesystem paths remain unchanged. */
export function snapshotPathLabel(value: string) {
  return value.replace(TERMINAL_CONTROLS, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
