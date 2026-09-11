export function safeTerminalText(value: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}
