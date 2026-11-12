import type { Appearance, DiagramLayout } from "./rasterizer.js";
export const PALETTES: Readonly<Record<Appearance, Readonly<Record<string, string>>>>;
export function normalizeSvg(source: string, kind: DiagramLayout["kind"], appearance?: Appearance): DiagramLayout;
