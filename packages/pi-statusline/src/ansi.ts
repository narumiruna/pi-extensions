export function ansiStyle(text: string, colors: { fg?: string; bg?: string }, trueColor = true): string {
  const codes = [
    colors.fg ? colorCode("38", colors.fg, trueColor) : undefined,
    colors.bg ? colorCode("48", colors.bg, trueColor) : undefined,
  ].filter((code): code is string => code !== undefined);
  if (codes.length === 0) return text;
  return `\u001b[${codes.join(";")}m${text}\u001b[0m`;
}

export function ansiFg(hex: string, text: string, trueColor = true): string {
  return ansiStyle(text, { fg: hex }, trueColor);
}

function colorCode(prefix: "38" | "48", hex: string, trueColor: boolean): string {
  const { red, green, blue } = hexToRgb(hex);
  return trueColor ? `${prefix};2;${red};${green};${blue}` : `${prefix};5;${rgbToAnsi256(red, green, blue)}`;
}

function rgbToAnsi256(red: number, green: number, blue: number): number {
  const channels = [red, green, blue].map((value) => Math.round((value / 255) * 5));
  return 16 + 36 * (channels[0] ?? 0) + 6 * (channels[1] ?? 0) + (channels[2] ?? 0);
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const normalized = hex.replace(/^#/, "");
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
  };
}
