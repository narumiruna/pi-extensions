export const LIMITS: Readonly<{
  sourceChars: number;
  svgBytes: number;
  maxEdges: number;
  maxPixels: number;
  pngBytes: number;
  dimension: number;
  maxPending: number;
  maxRasterDimension: number;
  startupMs: number;
  timeoutMs: number;
  heapMb: number;
  elements: number;
  depth: number;
  cssRules: number;
}>;
export function checkGeometry(width: number, height: number): void;
export function checkPixels(width: number, height: number): void;
