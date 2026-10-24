import { isDeepStrictEqual as equal } from "node:util";
import { type AgentSession, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export const HOST_INTENT = "durable-host.intent.v1";
export const HOST_REPORT = "durable-host.report.v1";

export interface HostIntent {
  sessionId: string;
  requestId: string;
  agentId: string;
  runId: string;
  task: string;
}

export interface HostReport {
  intentEntryId: string;
  reportId: string;
  intent: HostIntent;
  content: string;
}

/**
 * Test-only, single-owner Pi receipt bridge, not a durable scheduler.
 * Report content and its receipt share one custom_message entry. A second custom
 * entry would introduce an additional report-append/receipt-append gap.
 * This proves process-visible JSONL reopen, not fsync or cross-store atomicity.
 */
export class DurableHost {
  private generation = 0;
  private stopped = false;
  private writeFailed = false;

  constructor(private session: AgentSession) {}

  replace(session: AgentSession): void {
    this.generation++;
    this.session = session;
  }

  dispose(): void {
    this.generation++;
    this.stopped = true;
  }

  intents(): { entryId: string; intent: HostIntent }[] {
    this.assertCurrent(this.session, this.generation);
    return this.session.sessionManager.getBranch().flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== HOST_INTENT) return [];
      // The fixture owns this versioned schema; it never imports user sessions.
      const intent = entry.data as HostIntent;
      return intent.sessionId === this.session.sessionId ? [{ entryId: this.diskReceipt(entry.id), intent }] : [];
    });
  }

  admit(intent: HostIntent): string {
    this.assertCurrent(this.session, this.generation);
    if (intent.sessionId !== this.session.sessionId) throw new Error("Wrong host session");
    const manager = this.session.sessionManager;
    // Pi does not create a session file for custom entries alone.
    if (
      !manager.isPersisted() ||
      !manager
        .getBranch()
        .some((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message.role))
    ) {
      throw new Error("A persisted Pi conversation is required before admission");
    }
    const existing = this.intents().find((receipt) => receipt.intent.requestId === intent.requestId);
    if (existing) {
      if (!equal(existing.intent, intent)) throw new Error("Conflicting admission retry");
      return this.diskReceipt(existing.entryId);
    }
    try {
      return this.diskReceipt(manager.appendCustomEntry(HOST_INTENT, intent));
    } catch (error) {
      // SessionManager indexes an entry before attempting the file append.
      this.writeFailed = true;
      throw error;
    }
  }

  /** The optional gate is caller-owned fault injection; it owns no timer or task. */
  async deliver(report: HostReport, beforePublication: Promise<void> = Promise.resolve()): Promise<string> {
    const session = this.session;
    const generation = this.generation;
    await beforePublication;
    this.assertCurrent(session, generation);
    const manager = session.sessionManager;
    if (report.intent.sessionId !== session.sessionId) throw new Error("Wrong host session");
    const admission = this.intents().find((receipt) => receipt.entryId === report.intentEntryId);
    if (!admission || !equal(admission.intent, report.intent))
      throw new Error("Intent is not owned by the active branch");
    const existing = this.findReport(manager.getBranch(), report);
    if (existing) return this.diskReceipt(existing.id);
    // Queued delivery is NOT a persistence acknowledgement. Retry at the idle boundary.
    if (!session.isIdle) throw new Error("Host is busy; report must remain pending");
    try {
      await session.sendCustomMessage(
        { customType: HOST_REPORT, content: report.content, display: false, details: report },
        { triggerTurn: false },
      );
    } catch (error) {
      if (this.session === session && this.generation === generation) this.writeFailed = true;
      throw error;
    }
    this.assertCurrent(session, generation);
    const receipt = this.findReport(manager.getBranch(), report);
    if (!receipt) throw new Error("No main-session report receipt; do not acknowledge the outbox");
    return this.diskReceipt(receipt.id);
  }

  private diskReceipt(entryId: string): string {
    try {
      const manager = this.session.sessionManager;
      const path = manager.getSessionFile();
      if (!path) throw new Error("No persistent Pi session file");
      const reopened = SessionManager.open(path);
      const entry = reopened.getEntry(entryId);
      if (reopened.getSessionId() !== this.session.sessionId || !entry || !equal(entry, manager.getEntry(entryId))) {
        throw new Error("Pi receipt is not present on disk; do not acknowledge the outbox");
      }
      return entryId;
    } catch (error) {
      this.writeFailed = true;
      throw error;
    }
  }

  private assertCurrent(session: AgentSession, generation: number): void {
    if (this.stopped || this.session !== session || this.generation !== generation)
      throw new Error("Stale host publication");
    if (this.writeFailed) throw new Error("Pi session append failed; discard this host and reopen from disk");
  }

  private findReport(entries: SessionEntry[], report: HostReport) {
    return entries.find((entry) => {
      if (entry.type !== "custom_message" || entry.customType !== HOST_REPORT) return false;
      const previous = entry.details as HostReport;
      if (previous.reportId !== report.reportId) return false;
      if (!equal(previous, report) || !equal(entry.content, report.content))
        throw new Error("Conflicting report retry");
      return true;
    });
  }
}
