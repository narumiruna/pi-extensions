import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_MUTEX_CHANNEL = "workflow:mutex:v1";
export const AGENT_WORKFLOW_GROUP = "agent-workflow";

export type WorkflowMutexOwner = symbol;

interface WorkflowMutexAttemptV1 {
  session: object;
  group: string;
  busy: boolean;
}

export class WorkflowMutex {
  private session: object | undefined;
  private readonly heldGroups = new Map<string, WorkflowMutexOwner>();
  private generation = 0;
  private readonly pi: Pick<ExtensionAPI, "events">;

  constructor(pi: Pick<ExtensionAPI, "events">) {
    this.pi = pi;
    pi.events.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
      this.answer(payload);
    });
  }

  bindSession(session: object): void {
    this.generation += 1;
    this.heldGroups.clear();
    this.session = session;
  }

  unbindSession(session: object): void {
    if (this.session !== session) return;
    this.generation += 1;
    this.heldGroups.clear();
    this.session = undefined;
  }

  acquire(group = AGENT_WORKFLOW_GROUP): WorkflowMutexOwner | undefined {
    const session = this.session;
    const generation = this.generation;
    if (!session || this.heldGroups.has(group)) return undefined;

    const attempt: WorkflowMutexAttemptV1 = { session, group, busy: false };
    try {
      this.pi.events.emit(WORKFLOW_MUTEX_CHANNEL, attempt);
    } catch {
      return undefined;
    }
    if (
      this.session !== session ||
      this.generation !== generation ||
      attempt.session !== session ||
      attempt.group !== group ||
      attempt.busy !== false ||
      this.heldGroups.has(group)
    ) {
      return undefined;
    }

    const owner = Symbol(group);
    this.heldGroups.set(group, owner);
    return owner;
  }

  isOwner(owner: WorkflowMutexOwner | undefined, group = AGENT_WORKFLOW_GROUP): boolean {
    return owner !== undefined && this.heldGroups.get(group) === owner;
  }

  release(owner: WorkflowMutexOwner | undefined, group = AGENT_WORKFLOW_GROUP): void {
    if (!this.isOwner(owner, group)) return;
    this.heldGroups.delete(group);
  }

  private answer(payload: unknown): void {
    try {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
      const attempt = payload as Partial<WorkflowMutexAttemptV1>;
      if (attempt.session !== this.session) return;
      if (attempt.group !== AGENT_WORKFLOW_GROUP) return;
      if (typeof attempt.busy !== "boolean") return;
      if (!this.heldGroups.has(attempt.group)) return;
      attempt.busy = true;
    } catch {
      // Protocol listeners must ignore unusual objects without interrupting sibling listeners.
    }
  }
}
