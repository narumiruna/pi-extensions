// Fixed safety budgets; these are not user settings.
export const LIMITS = Object.freeze({
  sourceChars: 50_000,
  svgBytes: 4 * 1024 * 1024,
  maxEdges: 1_000,
  maxPixels: 8_000_000,
  pngBytes: 4 * 1024 * 1024,
  dimension: 100_000,
  maxPending: 4,
  maxRasterDimension: 8_192,
  startupMs: 5_000,
  timeoutMs: 5_000,
  heapMb: 128,
  elements: 20_000,
  depth: 128,
  cssRules: 1_000,
});

/** @param {number} width @param {number} height */
export function checkGeometry(width, height) {
  if (![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= LIMITS.dimension)) {
    throw new Error("SVG dimensions must be finite, positive, and at most 100000 units.");
  }
}

/** @param {number} width @param {number} height */
export function checkPixels(width, height) {
  checkGeometry(width, height);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width > LIMITS.maxRasterDimension ||
    height > LIMITS.maxRasterDimension ||
    width * height > LIMITS.maxPixels
  ) {
    throw new Error("Raster exceeds the 8000000 pixel limit.");
  }
}
