# Proposed Pi core APIs for native subagent sessions

Date: 2026-07-11

## Finding

The extension API supports subprocess execution, custom tools, custom transcript entries, session persistence, and temporary TUI components. It does not expose a supported way to create a child `AgentSession`, send turns to it, subscribe to its transcript, switch the interactive transcript to it, or inherit the current turn's resolved approval/sandbox policy. Building native transcript navigation inside the extension would require private Pi internals and was therefore not implemented.

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

`pi-subagents` should retain its batch API and place child execution behind a transport interface. When the proposed API exists, the current logical registry can replace its fresh-process runner with a `ChildSessionHandle` adapter while preserving opaque IDs and lifecycle tools. Existing persisted logical histories remain readable and can be imported as context for the first native child turn.
