import { Heading } from "@radix-ui/themes";
import type { CacheHistory, CacheRecord } from "../model.js";
import { CacheTrend } from "./cache-trend.js";
import "./cache.css";

function numeric(value: number | null | undefined, suffix = ""): string {
  return value == null ? "unavailable" : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}
function money(value: number | null | undefined): string {
  return value == null ? "unavailable" : `$${value.toFixed(6)}`;
}
function Record({ record, select }: { record: CacheRecord; select(id: string): void }) {
  const comparison = record.comparison;
  return (
    <details className="cache-record">
      <summary>
        <span>
          {record.kind} · {record.status}
        </span>
        <span>
          {record.provider} / {record.model}
        </span>
        <span>Hit {numeric(record.hitRatePercent, "%")}</span>
        <time>{record.timestamp}</time>
      </summary>
      <dl className="cache-metrics">
        <div>
          <dt>Input tokens</dt>
          <dd>{numeric(record.input)}</dd>
        </div>
        <div>
          <dt>Cache read tokens</dt>
          <dd>{numeric(record.cacheRead)}</dd>
        </div>
        <div>
          <dt>Cache write tokens</dt>
          <dd>{numeric(record.cacheWrite)}</dd>
        </div>
        <div>
          <dt>Prompt tokens</dt>
          <dd>{numeric(record.promptTokens)}</dd>
        </div>
        <div>
          <dt>Prompt cost</dt>
          <dd>{money(record.promptCost)}</dd>
        </div>
        <div>
          <dt>Estimated savings</dt>
          <dd>{money(record.estimatedSavings)}</dd>
        </div>
        <div>
          <dt>Cost source</dt>
          <dd>{record.costSource}</dd>
        </div>
        <div>
          <dt>Prefix epoch</dt>
          <dd>{record.epoch}</dd>
        </div>
      </dl>
      {record.kind !== "assistant" && (
        <p className="cache-note">Auxiliary usage: included in totals, not request comparisons or trend.</p>
      )}
      {comparison ? (
        <div className="cache-comparison">
          <dl className="cache-metrics">
            <div>
              <dt>Hit-rate change</dt>
              <dd>{numeric(comparison.hitRateDeltaPercent, " pp")}</dd>
            </div>
            <div>
              <dt>Hit-rate loss</dt>
              <dd>{numeric(comparison.hitRateLossPercent, " pp")}</dd>
            </div>
            <div>
              <dt>Prompt-token change</dt>
              <dd>{numeric(comparison.promptTokenDelta)}</dd>
            </div>
            <div>
              <dt>Cache-read change</dt>
              <dd>{numeric(comparison.cacheReadDelta)}</dd>
            </div>
            <div>
              <dt>Eligible tokens (estimate)</dt>
              <dd>{numeric(comparison.eligibleTokens)}</dd>
            </div>
            <div>
              <dt>Re-billed tokens (estimate)</dt>
              <dd>{numeric(comparison.rebilledTokens)}</dd>
            </div>
            <div>
              <dt>Estimated miss premium</dt>
              <dd>{money(comparison.estimatedMissPremium)}</dd>
            </div>
            <div>
              <dt>Request start gap</dt>
              <dd>{numeric(comparison.requestStartGapMs, " ms")}</dd>
            </div>
          </dl>
          {comparison.modelChanged && <p>Provider or model changed; token counts do not prove prefix reuse.</p>}
        </div>
      ) : (
        <p className="cache-note">Comparison unavailable: no adjacent comparable response in this epoch.</p>
      )}
      <button type="button" onClick={() => select(record.entryId)}>
        View event details
      </button>
    </details>
  );
}

export function Cache({ report, select }: { report?: CacheHistory; select(id: string): void }) {
  if (!report)
    return (
      <section className="cache-view">
        <Heading size="5">Cache usage</Heading>
        <p>Cache history unavailable in this snapshot.</p>
      </section>
    );
  return (
    <section className="cache-view" aria-label="Cache usage">
      <Heading size="5">Cache usage</Heading>
      <p>
        Active branch leaf: <code>{report.leafId ?? "none"}</code>
      </p>
      <p className="cache-note">
        Recorded session usage, not a transport-attempt log. Costs and reusable-prefix metrics are estimates. No
        streaming preview.
      </p>
      {!report.complete && <p role="status">Cache data is incomplete; totals are not a complete branch report.</p>}
      {report.unavailable ? (
        <p role="status">Cache history unavailable: {report.unavailable}</p>
      ) : (
        <>
          <dl className="cache-metrics cache-totals" aria-label="Branch cache totals">
            <div>
              <dt>Usage records</dt>
              <dd>{report.totals.count}</dd>
            </div>
            <div>
              <dt>Weighted hit rate</dt>
              <dd>{numeric(report.totals.hitRatePercent, "%")}</dd>
            </div>
            <div>
              <dt>Input tokens</dt>
              <dd>{numeric(report.totals.input)}</dd>
            </div>
            <div>
              <dt>Cache read tokens</dt>
              <dd>{numeric(report.totals.cacheRead)}</dd>
            </div>
            <div>
              <dt>Cache write tokens</dt>
              <dd>{numeric(report.totals.cacheWrite)}</dd>
            </div>
            <div>
              <dt>Prompt tokens</dt>
              <dd>{numeric(report.totals.promptTokens)}</dd>
            </div>
            <div>
              <dt>Prompt cost</dt>
              <dd>{money(report.totals.promptCost)}</dd>
            </div>
            <div>
              <dt>Estimated savings</dt>
              <dd>{money(report.totals.estimatedSavings)}</dd>
            </div>
          </dl>
          <CacheTrend points={report.trend} select={select} />
          <Heading size="3">Recorded usage</Heading>
          <p>
            Showing {report.records.length} of {report.totalRecords} records · {report.omittedRecords} older records
            omitted. Totals include all validated branch records.
          </p>
          {report.records.length === 0 && <p>No recorded usage on this branch.</p>}
          <div className="cache-records">
            {report.records.map((record) => (
              <Record key={record.entryId} record={record} select={select} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
