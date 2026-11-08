import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type UsageContext = Pick<ExtensionContext, "sessionManager" | "model">;
type RecordValue = Record<string, unknown>;
type Bucket = {
  id: string;
  modelKeys?: string[];
  used?: number;
  remaining?: number;
  limit?: number;
  resetsAt?: number;
};
const DEADLINE_MS = 15_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const UNITS = new Set(["percent", "usd", "currency", "count"]);

/**
 * Read a scheduling hint through the public usage v1 protocol, without retaining a report.
 * Call from session_start or later. The owner must abort on Goal/generation replacement,
 * model/session changes, and shutdown, then revalidate its own ownership after awaiting.
 */
export async function readUsageReset(
  pi: Pick<ExtensionAPI, "events">,
  ctx: UsageContext,
  signal: AbortSignal,
): Promise<number | undefined> {
  try {
    if (signal.aborted) return undefined;
    const session = ctx.sessionManager;
    const sessionId = session.getSessionId();
    const model = ctx.model;
    if (!model?.provider || !model.id || !model.name || typeof sessionId !== "string" || !sessionId) {
      return undefined;
    }
    const provider = model.provider;
    const modelId = model.id;
    const modelName = model.name;
    const snapshot = JSON.stringify(model);
    const startedAt = Date.now();
    const deadline = performance.now() + DEADLINE_MS;
    const current = () =>
      !signal.aborted &&
      performance.now() < deadline &&
      ctx.sessionManager === session &&
      session.getSessionId() === sessionId &&
      ctx.model === model &&
      JSON.stringify(ctx.model) === snapshot;

    const result = await new Promise<unknown>((resolve) => {
      const controller = new AbortController();
      let open = true;
      let offered = false;
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value?: unknown) => {
        if (done) return;
        done = true;
        open = false;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        resolve(value);
        controller.abort();
      };
      const cancel = () => finish();
      try {
        timer = setTimeout(cancel, DEADLINE_MS);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) {
          finish();
          return;
        }
        pi.events.emit("usage:query:v1", {
          session,
          sessionId,
          providerId: provider,
          refresh: true,
          signal: controller.signal,
          respond(value: unknown) {
            const accepted = open && !offered && !done;
            if (accepted) offered = true;
            // Observe every offer, including rejected duplicates and late promises.
            void Promise.resolve(value).then(
              (answer) => {
                if (accepted && !done) finish(answer);
              },
              () => {
                if (accepted && !done) finish();
              },
            );
            return accepted;
          },
        });
        // Event listeners can synchronously replace the session or mutate the model.
        if (!current()) finish();
      } catch {
        finish();
      } finally {
        open = false;
      }
      if (!offered) finish();
    });
    if (!current()) return undefined;
    const reset = selectReset(result, provider, modelId, modelName, startedAt);
    return current() ? reset : undefined;
  } catch {
    // Neither protocol failures nor stale context getters may escape into recovery.
    return undefined;
  }
}

// Read only known own data properties. Reject accessors without running them, and
// detach nested records and array entries before validation or deadline selection.
// Do not enumerate unknown fields or use provider-controlled array iterators.
function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new TypeError("Usage fields must be data properties");
  return descriptor.value;
}

function snapshotFields(value: unknown, fields: readonly string[]): RecordValue {
  if (!isRecord(value)) throw new TypeError("Usage records must be objects");
  const snapshot: RecordValue = {};
  for (const field of fields) snapshot[field] = dataProperty(value, field);
  return snapshot;
}

function snapshotArray(value: unknown, project: (item: unknown) => unknown = (item) => item): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Usage lists must be arrays");
  const length = dataProperty(value, "length");
  if (!isFiniteNumber(length) || !Number.isInteger(length) || length < 0 || length > 0xffff_ffff) {
    throw new TypeError("Usage arrays must have a valid length");
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index++) snapshot.push(project(dataProperty(value, String(index))));
  return snapshot;
}

function snapshotBucket(value: unknown): RecordValue {
  const bucket = snapshotFields(value, [
    "id",
    "label",
    "groupId",
    "groupLabel",
    "modelKeys",
    "used",
    "remaining",
    "limit",
    "unit",
    "period",
    "windowMinutes",
    "resetsAt",
  ]);
  if (bucket.modelKeys !== undefined) bucket.modelKeys = snapshotArray(bucket.modelKeys);
  return bucket;
}

function snapshotResult(input: unknown): RecordValue {
  const value = snapshotFields(input, ["status", "providerId", "source", "expiresAt", "report"]);
  const report = snapshotFields(value.report, [
    "providerId",
    "providerName",
    "capturedAt",
    "source",
    "semantics",
    "accountLabel",
    "buckets",
    "metrics",
    "notes",
  ]);
  value.report = report;
  report.semantics = snapshotFields(report.semantics, ["kind", "label"]);
  report.buckets = snapshotArray(report.buckets, snapshotBucket);
  report.metrics = snapshotArray(report.metrics, (metric) =>
    snapshotFields(metric, ["id", "label", "value", "unit", "currency"]),
  );
  if (report.notes !== undefined) report.notes = snapshotArray(report.notes);
  return value;
}

function selectReset(
  input: unknown,
  provider: string,
  modelId: string,
  modelName: string,
  startedAt: number,
): number | undefined {
  const value = snapshotResult(input);
  const now = Date.now();
  if (
    value.status !== "ready" ||
    value.providerId !== provider ||
    value.source !== "refresh" ||
    !isTimestamp(value.expiresAt) ||
    value.expiresAt <= now
  ) {
    return undefined;
  }
  const report = value.report;
  if (
    !isRecord(report) ||
    report.providerId !== provider ||
    typeof report.providerName !== "string" ||
    typeof report.source !== "string" ||
    !isTimestamp(report.capturedAt) ||
    report.capturedAt < startedAt ||
    report.capturedAt > now ||
    !isRecord(report.semantics) ||
    typeof report.semantics.kind !== "string" ||
    !["consumer-subscription", "api-key", "project"].includes(report.semantics.kind) ||
    typeof report.semantics.label !== "string" ||
    !optional(report.accountLabel, isString) ||
    !optional(report.notes, isStrings) ||
    !Array.isArray(report.buckets) ||
    !Array.isArray(report.metrics) ||
    ![...report.metrics].every(isMetric)
  ) {
    return undefined;
  }

  const buckets: unknown[] = [...report.buckets];
  if (!buckets.every(isBucket)) return undefined;
  let latest: number | undefined;
  const constraints = new Set<string>();
  for (const bucket of buckets) {
    // Repeated constraint identities leave their window relationship ambiguous.
    if (constraints.has(bucket.id)) return undefined;
    constraints.add(bucket.id);
    // V1 has no base/all-model marker. Omitted/empty modelKeys cannot prove scope,
    // even when a label, group, or opaque ID suggests a provider-wide allowance.
    // Do not infer scope or window relationships from those presentation fields.
    if (!bucket.modelKeys?.length) return undefined;
    if (!bucket.modelKeys.includes(modelId) && !bucket.modelKeys.includes(modelName)) continue;

    const { used, remaining, limit } = bucket;
    // Zero/negative limits and negative usage do not prove meaningful quota bounds.
    if ((used !== undefined && used < 0) || (limit !== undefined && limit <= 0)) return undefined;
    const byRemaining = remaining === undefined ? undefined : remaining <= 0;
    const byUsage = used === undefined || limit === undefined ? undefined : used >= limit;
    if (byRemaining === undefined && byUsage === undefined) return undefined;
    if (byRemaining !== undefined && byUsage !== undefined && byRemaining !== byUsage) return undefined;
    if (!(byRemaining ?? byUsage)) continue;
    if (!isTimestamp(bucket.resetsAt) || bucket.resetsAt <= now) return undefined;
    // Treat confirmed constraints separately: availability requires all to reset.
    // This does not add measurements or infer a request-specific retry guarantee.
    latest = Math.max(latest ?? bucket.resetsAt, bucket.resetsAt);
  }
  const completedAt = Date.now();
  return isTimestamp(latest) &&
    latest > completedAt &&
    value.expiresAt > completedAt &&
    report.capturedAt <= completedAt
    ? latest
    : undefined;
}

function isBucket(value: unknown): value is Bucket {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.unit === "string" &&
    UNITS.has(value.unit) &&
    optional(value.groupId, isString) &&
    optional(value.groupLabel, isString) &&
    optional(value.modelKeys, isStrings) &&
    optional(value.used, isFiniteNumber) &&
    optional(value.remaining, isFiniteNumber) &&
    optional(value.limit, isFiniteNumber) &&
    optional(value.period, isString) &&
    optional(value.windowMinutes, (number) => isFiniteNumber(number) && number > 0) &&
    optional(value.resetsAt, isTimestamp)
  );
}

function isMetric(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (typeof value.value === "string" || isFiniteNumber(value.value)) &&
    optional(value.unit, (unit) => typeof unit === "string" && UNITS.has(unit)) &&
    optional(value.currency, isString)
  );
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && [...value].every(isString);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP_MS;
}

function optional(value: unknown, validate: (value: unknown) => boolean): boolean {
  return value === undefined || validate(value);
}
