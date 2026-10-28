import { Heading } from "@radix-ui/themes";
import { useState } from "react";
import type { CacheHistory } from "../model.js";

type Point = CacheHistory["trend"][number];
export type HitRateBand = "Low" | "Moderate" | "High" | "Unavailable";

export function hitRateBand(value: number | null): HitRateBand {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 100) return "Unavailable";
  return value < 50 ? "Low" : value < 90 ? "Moderate" : "High";
}

export function formatHitRate(value: number | null): string {
  if (hitRateBand(value) === "Unavailable" || value === null) return "unavailable";
  const rounded = Number(value.toFixed(2));
  // Rounding must not make a low/moderate sample appear to meet the next target.
  if (value > 0 && rounded === 0) return "<0.01%";
  for (const boundary of [50, 90, 100]) {
    if (value < boundary && rounded >= boundary) return `<${boundary}%`;
  }
  return `${rounded.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

export function summarizeTrend(points: readonly Point[]) {
  const known = points
    .map((point) => point.hitRatePercent)
    .filter((value): value is number => hitRateBand(value) !== "Unavailable");
  const latest = points.at(-1)?.hitRatePercent ?? null;
  return {
    latest: hitRateBand(latest) === "Unavailable" ? null : latest,
    minimum: known.length ? Math.min(...known) : null,
  };
}

function exactHitRate(value: number | null): string {
  return hitRateBand(value) === "Unavailable" ? "unavailable" : `${value}%`;
}

function epochBoundary(points: readonly Point[], index: number): boolean {
  const previous = points[index - 1]?.epoch;
  const current = points[index]?.epoch;
  return (
    typeof previous === "number" &&
    Number.isSafeInteger(previous) &&
    previous >= 0 &&
    typeof current === "number" &&
    Number.isSafeInteger(current) &&
    current >= 0 &&
    previous !== current
  );
}

export function CacheTrend({ points, select }: { points: CacheHistory["trend"]; select(id: string): void }) {
  const [inspectedId, setInspectedId] = useState<string>();
  const summary = summarizeTrend(points);
  // Selection belongs to the current snapshot, never to a replaced branch's data.
  const matchedIndex = points.findIndex((point) => point.entryId === inspectedId);
  const inspectedIndex = matchedIndex < 0 ? points.length - 1 : matchedIndex;
  const inspected = points[inspectedIndex];
  const hasBoundary = points.some((_, index) => epochBoundary(points, index));
  return (
    <section className="cache-trend-view" aria-label="Hit-rate trend">
      <Heading size="3">Hit-rate trend</Heading>
      {points.length === 0 ? (
        <p className="cache-note">No conversational responses yet. The trend appears after a response is recorded.</p>
      ) : (
        <>
          <p className="cache-note">
            Latest {points.length} conversational response{points.length === 1 ? "" : "s"}, oldest first.
          </p>
          <dl className="cache-trend-summary" aria-label="Displayed window hit rates">
            <div>
              <dt>Latest</dt>
              <dd data-band={hitRateBand(summary.latest)}>{formatHitRate(summary.latest)}</dd>
            </div>
            <div>
              <dt>Minimum known</dt>
              <dd data-band={hitRateBand(summary.minimum)}>{formatHitRate(summary.minimum)}</dd>
            </div>
          </dl>
          {summary.minimum === null ? (
            <>
              <p className="cache-note">Hit rate is unavailable for the recorded responses.</p>
              <ol className="cache-trend-values" aria-label="Response hit rates">
                {points.map((point, index) => (
                  <li key={point.entryId} data-band="Unavailable">
                    <button
                      type="button"
                      aria-label={`Response ${index + 1} of ${points.length}: unavailable · Unavailable. View event details.`}
                      onClick={() => select(point.entryId)}
                    >
                      {index + 1}: unavailable · View event details
                    </button>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <>
              <ul className="cache-trend-legend" aria-label="Hit-rate bands">
                <li data-band="Low">Low &lt;50%</li>
                <li data-band="Moderate">Moderate 50–&lt;90%</li>
                <li data-band="High">High ≥90%</li>
                <li data-band="Unavailable">Unavailable</li>
              </ul>
              <div className="cache-trend-chart">
                <div className="cache-trend-axis" aria-hidden="true">
                  {[100, 90, 50, 0].map((value) => (
                    <span key={value} style={{ bottom: `${value}%` }}>
                      {value}%
                    </span>
                  ))}
                </div>
                <div className="cache-trend-scroll">
                  <div className="cache-trend-track">
                    <div className="cache-trend-grid" aria-hidden="true">
                      {[100, 90, 50, 0].map((value) => (
                        <span key={value} style={{ bottom: `${value}%` }} />
                      ))}
                    </div>
                    <ol className="cache-trend" aria-label="Conversational hit-rate trend">
                      {points.map((point, index) => {
                        const band = hitRateBand(point.hitRatePercent);
                        return (
                          <li key={point.entryId} data-band={band}>
                            {epochBoundary(points, index) && (
                              <hr
                                className="cache-trend-boundary"
                                aria-orientation="vertical"
                                aria-label={`New prefix epoch ${point.epoch} before response ${index + 1}`}
                              />
                            )}
                            <button
                              type="button"
                              className="cache-trend-point"
                              aria-label={`Response ${index + 1} of ${points.length}: ${exactHitRate(point.hitRatePercent)} · ${band}. View event details.`}
                              onFocus={() => setInspectedId(point.entryId)}
                              onMouseEnter={() => setInspectedId(point.entryId)}
                              onClick={() => select(point.entryId)}
                            >
                              {band === "Unavailable" ? (
                                <span className="cache-trend-unknown" aria-hidden="true">
                                  ×
                                </span>
                              ) : point.hitRatePercent === 0 ? (
                                <span className="cache-trend-zero" aria-hidden="true" />
                              ) : (
                                <span
                                  className="cache-trend-bar"
                                  aria-hidden="true"
                                  style={{ height: `${point.hitRatePercent}%` }}
                                />
                              )}
                            </button>
                            <span className="cache-trend-index" aria-hidden="true">
                              {index + 1}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                </div>
              </div>
              {points.length <= 3 && (
                <ol className="cache-trend-values" aria-label="Response hit rates">
                  {points.map((point, index) => (
                    <li key={point.entryId} data-band={hitRateBand(point.hitRatePercent)}>
                      {index + 1}: {exactHitRate(point.hitRatePercent)} · {hitRateBand(point.hitRatePercent)}
                    </li>
                  ))}
                </ol>
              )}
              {inspected && (
                <p className="cache-trend-inspection" data-band={hitRateBand(inspected.hitRatePercent)}>
                  Response {inspectedIndex + 1} of {points.length}:{" "}
                  <strong>{exactHitRate(inspected.hitRatePercent)}</strong> · {hitRateBand(inspected.hitRatePercent)}
                  <span className="cache-note"> · Activate a bar to view event details.</span>
                </p>
              )}
              <p className="cache-note">
                High is a display target, not a provider guarantee. Unknown values are not 0%.
                {hasBoundary && " Dashed lines mark prefix epoch changes; comparisons reset at each boundary."}
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
