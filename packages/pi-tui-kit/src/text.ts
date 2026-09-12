export function safeMenuText(value: unknown) {
  return replaceTerminalControls(value).replace(/\s+/gu, " ").trim();
}

export function replaceTerminalControls(value: unknown) {
  return Array.from(String(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }).join("");
}
