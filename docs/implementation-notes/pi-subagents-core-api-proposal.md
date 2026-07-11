# Proposed Pi core APIs for core-owned subagent sessions

Date: 2026-07-11

## Finding

The public Pi SDK now supports extension-owned in-memory child execution through `createAgentSession()`, `SessionManager.inMemory()`, resource/model/settings managers, subscriptions, abort, and disposal. `pi-subagents` uses that surface for its opt-in `in-process` transport.

Pi still does not expose a core-owned child-session tree that inherits the current turn's resolved approval/sandbox/header policy, participates in global scheduling, persists through core lifecycle semantics, or switches the interactive transcript. Building those capabilities inside an extension would require private internals and remains out of scope.

## Minimal proposed API

```ts
interface ChildSessionOptions {
  cwd: string;
  context: "none" | "all" | { recentTurns: number };
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  inheritPolicy: true;
}

interface ChildSessionHandle {
  id: string;
  status(): "idle" | "running" | "interrupted" | "closed";
  send(content: UserContent, options?: { signal?: AbortSignal }): Promise<AssistantMessage>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  entries(): readonly SessionEntry[];
  onEntry(listener: (entry: SessionEntry) => void): () => void;
}

interface ExtensionAPI {
  createChildSession(options: ChildSessionOptions): Promise<ChildSessionHandle>;
}

interface ExtensionCommandContext {
  inspectChildSession(id: string): Promise<void>;
}
```

## Required guarantees

- Child creation receives the currently resolved provider/model, approval policy, sandbox/execution profile, environment policy, and cwd after role overrides.
- Context forking has a core-owned sanitizer that excludes reasoning and tool transport records unless explicitly supported.
- Child sessions are owned by the parent session tree and receive shutdown/reload events.
- Concurrency is accounted globally across root and child turns.
- Transcript inspection never changes the active root session or invalidates captured extension contexts.
- Persistence is versioned by Pi core and never resumes side effects automatically.

## Migration path

`pi-subagents` retains its batch API and places stateful execution behind `SubagentTransport`. `InProcessTransport` currently adapts extension-owned public SDK sessions while `SubprocessTransport` remains the default fallback. If Pi later adds the core-owned handle above, another adapter can preserve opaque IDs, hierarchy, mailboxes, lifecycle tools, and stored logical histories while gaining core policy inheritance, scheduling, persistence, and transcript inspection. No private Pi imports, runtime casts, or `ExtensionAPI` monkey-patching are permitted.
