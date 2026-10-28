import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Collector } from "./collector.js";
import { captureContext } from "./context.js";
import { EntryIndex } from "./entry-index.js";
import { recordedLeaf } from "./identity.js";
import type { ContextComposition, SkillView, Snapshot } from "./model.js";
import { capture, readSessionName } from "./privacy.js";
import { snapshot } from "./projection.js";
import { mcpRegistrations } from "./resources.js";
import { projectToolCatalog } from "./tool-catalog.js";

export class SessionFeed {
  private dirty = true;
  private observed?: ContextComposition;
  private providerObservation?: Snapshot["providerObservation"];
  observeContext(messages: readonly unknown[]): void {
    if (this.closed || this.options.signal.aborted) return;
    this.observed = captureContext(
      messages,
      "observed-pi-context",
      recordedLeaf(this.options.context().sessionManager, this.index().duplicates),
    );
    this.observed.observedAt = Date.now();
    this.changed(false);
  }
  observePayload(payload: unknown): void {
    if (this.closed || this.options.signal.aborted) return;
    // No public request identity associates this callback with a turn; warming/retries use it too.
    this.providerObservation = { observedAt: Date.now(), data: capture(payload, 65536) };
    this.changed(false);
  }
  private indexed?: EntryIndex;
  private closed = false;
  index(): EntryIndex {
    if (this.closed || this.options.signal.aborted) throw new Error("Inspector stopped");
    if (!this.indexed) this.indexed = new EntryIndex(this.options.context().sessionManager.getEntries());
    return this.indexed;
  }
  private cached?: Snapshot;
  private revision = 0;
  private stamp = "";
  private notification?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  constructor(
    private readonly options: {
      pi: ExtensionAPI;
      context(): ExtensionContext;
      collector: Collector;
      skills: SkillView[];
      generation: string;
      signal: AbortSignal;
      invalidate(revision: number): void;
    },
  ) {}
  private stateStamp(): string {
    const ctx = this.options.context();
    const manager = ctx.sessionManager;
    const tools = this.options.pi.getAllTools();
    const active = this.options.pi.getActiveTools();
    // Public SDK method, omitted from the current ReadonlySessionManager type; readonly adapters may lack it.
    const counted = manager as typeof manager & { getEntryCount?: () => number };
    const count = typeof counted.getEntryCount === "function" ? counted.getEntryCount() : manager.getEntries().length;
    return JSON.stringify({
      count,
      leaf: recordedLeaf(manager),
      name: readSessionName(manager),
      mcp: mcpRegistrations(this.options.pi),
      toolCount: tools.length,
      // Opaque catalog/group IDs also detect raw identity changes beyond the display budget.
      tools: projectToolCatalog(tools, active),
    });
  }
  start(): void {
    if (this.options.signal.aborted || this.poll) return;
    this.stamp = this.stateStamp();
    this.poll = setInterval(() => {
      if (this.options.signal.aborted) return;
      try {
        const next = this.stateStamp();
        if (next !== this.stamp) {
          this.stamp = next;
          this.changed(true);
        }
      } catch {
        this.changed(true);
      } // Context failures must not escape a timer callback.
    }, 1000);
    this.options.signal.addEventListener("abort", this.close, { once: true });
  }
  changed(structural: boolean): void {
    if (this.options.signal.aborted) return;
    if (structural) {
      this.dirty = true;
      this.indexed = undefined;
    }
    if (!this.notification)
      this.notification = setTimeout(() => {
        this.notification = undefined;
        if (!this.options.signal.aborted) this.options.invalidate(++this.revision);
      }, 250);
  }
  snapshot(): Snapshot {
    if (this.closed || this.options.signal.aborted) throw new Error("Inspector stopped");
    if (!this.cached || this.dirty) {
      const ctx = this.options.context();
      this.cached = snapshot(
        ctx.sessionManager,
        this.options.collector,
        this.options.generation,
        this.revision,
        ctx.getSystemPrompt(),
        this.options.pi.getAllTools(),
        this.options.pi.getActiveTools(),
        this.options.skills,
        this.index(),
        this.observed,
        (provider, model) => ctx.modelRegistry?.find(provider, model),
      );
      this.cached.calls = []; // Do not retain evicted live results inside the static cache.
      this.dirty = false;
    }
    return {
      ...this.cached,
      revision: this.revision,
      context: this.observed ?? this.cached.context,
      providerObservation: this.providerObservation,
      mcp: mcpRegistrations(this.options.pi),
      calls: this.options.collector.list(),
      droppedCalls: this.options.collector.dropped,
      invalidCallEvents: this.options.collector.invalidEvents,
    };
  }
  close = (): void => {
    this.closed = true;
    clearTimeout(this.notification);
    clearInterval(this.poll);
    this.notification = undefined;
    this.poll = undefined;
    this.options.signal.removeEventListener("abort", this.close);
    this.cached = undefined;
    this.indexed = undefined;
    this.observed = undefined;
    this.providerObservation = undefined;
  };
}
