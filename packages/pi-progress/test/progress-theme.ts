import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, Theme, type ThemeBg, type ThemeColor } from "@earendil-works/pi-coding-agent";

const schema = JSON.parse(readFileSync(join(getPackageDir(), "schemas/theme.schema.json"), "utf8"));
const roles = Object.keys(schema.properties.colors.properties);
// Pi's public ThemeBg members, not names inferred from a suffix.
export const backgroundRoles = {
  selectedBg: true,
  searchMatchBg: true,
  userMessageBg: true,
  customMessageBg: true,
  toolPendingBg: true,
  toolSuccessBg: true,
  toolErrorBg: true,
} satisfies Record<ThemeBg, true>;
export const foregroundRoles = roles.filter((role) => !Object.hasOwn(backgroundRoles, role)) as ThemeColor[];

export function createProgressTheme(
  offset = 0,
  overrides: Partial<Record<ThemeColor, string>> = {},
  dim: ThemeColor[] = [],
) {
  const entries = roles.map((role, index) => [
    role,
    Object.hasOwn(overrides, role)
      ? overrides[role as ThemeColor]
      : `#${(0x203040 + index * 0x010101 + offset).toString(16).padStart(6, "0")}`,
  ]);
  return new Theme(
    Object.fromEntries(
      entries.filter(([role]) => !Object.hasOwn(backgroundRoles, role as string)),
    ) as ConstructorParameters<typeof Theme>[0],
    Object.fromEntries(
      entries.filter(([role]) => Object.hasOwn(backgroundRoles, role as string)),
    ) as ConstructorParameters<typeof Theme>[1],
    "truecolor",
    { appearance: "dark", dim },
  );
}
