import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerRuntime } from "../src/durable-controller.js";
import { WorkflowDoc } from "../src/durable-state.js";
import { barrier, type ControllerStorage, controllerFixture } from "./durable-controller-support.js";

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing expected test value");
  return value;
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(storage?: ControllerStorage) {
  const f = await controllerFixture(storage);
  cleanup.push(f.close);
  return f;
}

describe("durable host controller", () => {
  it("construction and inspection do not resume; start atomically stores the task and deduplicates exact operations", async () => {
    const f = await fixture();
    expect(f.runtime.getHarness()).toBe(f.harness);
    expect(await f.controller.inspect(f.root, context)).toMatchObject({
      phase: "inactive",
      workflowId: null,
      revision: 0,
    });
    expect((await f.harness.inspect(context)).scheduling).toBe("paused");
    f.faux.setResponses([fauxAssistantMessage("planning")]);
    const input = {
      operationId: "prompt",
      workflowId: "workflow-1",
      expected: { workflowId: null, revision: 0 },
      prompt: "Exact planning request",
    };
    await Promise.all([f.controller.start(f.root, input, context), f.controller.start(f.root, input, context)]);
    const settled = await f.settle("prompt");
    const receipt = required(settled.receipts.find((item) => item.operationId === "prompt"));
    expect(receipt).toMatchObject({ status: "done", revision: 1 });
    expect(receipt.taskId).toBeDefined();
    expect(receipt.submissionId).toBeDefined();
    await required(await f.harness.submission(required(receipt.submissionId), context)).wait(context);
    expect(
      (await f.root.context(context)).messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual([input.prompt]);
    await expect(f.controller.start(f.root, { ...input, prompt: "different" }, context)).rejects.toThrow(
      "different payload",
    );
    expect(f.faux.state.callCount).toBe(1);
  });

  it("foreign handles supply only bound-Harness IDs and cannot mutate a foreign ledger", async () => {
    const local = await fixture();
    const foreign = await fixture();
    expect(local.root.id).toBe(foreign.root.id);
    const unknown = await foreign.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await expect(local.controller.inspect(unknown, context)).rejects.toThrow("does not exist");
    const started = await local.controller.start(
      foreign.root,
      {
        operationId: "foreign-handle",
        workflowId: "local-workflow",
        expected: { workflowId: null, revision: 0 },
      },
      context,
    );
    expect(started.workflowId).toBe("local-workflow");
    await local.controller.reconcile(foreign.root, context);
    expect((await local.controller.inspect(local.root, context)).workflowId).toBe("local-workflow");
    expect((await foreign.controller.inspect(foreign.root, context)).workflowId).toBeNull();
    expect((await foreign.harness.inspect(context)).scheduling).toBe("paused");
  });

  it("approval waits for ordinary idle and records implementation only after verified native placement", async () => {
    const f = await fixture();
    const ready = await f.ready();
    const competing = await f.busy();
    const pending = await f.controller.approve(
      f.root,
      { operationId: "approve", expected: f.identity(ready) },
      context,
    );
    expect(pending).toMatchObject({ phase: "handoff_pending", approval: { planRevision: ready.revision } });
    expect(pending.approval?.submissionId).toBeUndefined();
    expect(pending.receipts.at(-1)).toMatchObject({ status: "pending", kind: "approve" });
    expect((await f.harness.snapshot(LiveDoc, f.root.id, context))?.run?.inputs).toEqual([competing.id]);
    let exact = false;
    f.faux.setResponses([
      (input) => {
        exact = input.messages.filter((message) => message.role === "user").at(-1)?.content === ready.plan;
        return fauxAssistantMessage("implementation complete");
      },
    ]);
    f.release.resolve();
    await competing.wait(context);
    const placed = await f.settle("approve");
    expect(placed.phase).toBe("implementing");
    expect(placed.approval?.submissionId).toBeDefined();
    await required(await f.harness.submission(required(placed.approval?.submissionId), context)).wait(context);
    expect(exact).toBe(true);
    expect(placed.delivery).toBeUndefined();
  });

  it.each(["approve", "revise"] as const)(
    "concurrent approve/revise has one winner when %s is admitted first",
    async (first) => {
      const f = await fixture();
      const ready = await f.ready();
      await f.busy();
      const approval = () =>
        f.controller.approve(f.root, { operationId: "approve", expected: f.identity(ready) }, context);
      const revision = () =>
        f.controller.revise(
          f.root,
          { operationId: "revise", expected: f.identity(ready), feedback: "Use another approach" },
          context,
        );
      const results = await Promise.allSettled(
        first === "approve" ? [approval(), revision()] : [revision(), approval()],
      );
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      const view = await f.controller.inspect(f.root, context);
      expect(view.phase).toBe(first === "approve" ? "handoff_pending" : "planning");
      expect(view.receipts.filter((receipt) => receipt.kind === "approve" || receipt.kind === "revise")).toHaveLength(
        1,
      );
      await f.controller.dispose(context);
    },
  );

  it("question cancellation does not invent an answer or submit input", async () => {
    const f = await fixture();
    await f.start();
    await f.root.commit(async (tx) => {
      const state = await tx.doc(WorkflowDoc, f.root.id);
      state.phase = "awaiting_answers";
      state.revision++;
      state.question = {
        batchId: 7,
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope?",
            options: [
              { label: "Package", description: "Only this package" },
              { label: "Repository", description: "All packages" },
            ],
          },
        ],
      };
    }, context);
    const before = await f.controller.inspect(f.root, context);
    const canceled = await f.controller.cancelQuestion(
      f.root,
      { operationId: "cancel", expected: f.identity(before) },
      context,
    );
    expect(canceled).toMatchObject({ phase: "planning", revision: before.revision + 1 });
    expect(canceled.question).toBeUndefined();
    expect(canceled.receipts.at(-1)).toMatchObject({ kind: "cancel_question", status: "done" });
    expect(f.faux.state.callCount).toBe(0);
  });

  it("answers are persisted and delivered once through their native request ID", async () => {
    const f = await fixture();
    await f.start();
    const question = {
      id: "scope",
      header: "Scope",
      question: "Which scope?",
      options: [
        { label: "Package", description: "Only this package" },
        { label: "Repository", description: "All packages" },
      ],
    };
    await f.root.commit(async (tx) => {
      const state = await tx.doc(WorkflowDoc, f.root.id);
      state.phase = "awaiting_answers";
      state.revision++;
      state.question = { batchId: 7, questions: [question] };
    }, context);
    const before = await f.controller.inspect(f.root, context);
    const input = {
      operationId: "answer",
      expected: f.identity(before),
      batchId: 7,
      answers: [
        { id: "scope", header: "Scope", question: "Which scope?", answer: "Package", optionIndex: 1, wasCustom: false },
      ],
    };
    f.faux.setResponses([fauxAssistantMessage("answered")]);
    await f.controller.answer(f.root, input, context);
    await f.settle("answer");
    await f.controller.answer(f.root, input, context);
    await f.root.waitForIdle(context);
    const inputs = (await f.root.context(context)).messages.filter((message) => message.role === "user");
    expect(inputs).toHaveLength(1);
    expect(JSON.parse(required(inputs[0]).content as string)).toMatchObject({
      type: "plan_mode_answers",
      batchId: 7,
      answers: input.answers,
    });
  });

  it("dispose aborts and joins only transition tasks, keeps the plan, and is idempotent", async () => {
    const f = await fixture();
    const ready = await f.ready();
    const competing = await f.busy();
    const unrelated = await f.root.commit(
      (tx) => tx.createTask(f.unrelated, {}, { ownership: { kind: "conversation" }, background: true }),
      context,
    );
    await f.controller.approve(f.root, { operationId: "approve", expected: f.identity(ready) }, context);
    const pending = await f.controller.inspect(f.root, context);
    await Promise.all([f.controller.dispose(context), f.controller.dispose(context)]);
    expect((await f.harness.getTask(required(pending.delivery?.taskId), context))?.state).toMatchObject({
      status: "terminal",
      outcome: { status: "aborted" },
    });
    expect((await f.harness.getTask(unrelated, context))?.abortRequested).toBe(false);
    expect((await f.harness.submission(competing.id, context)) && (await competing.status(context)).status).toBe(
      "placed",
    );
    const retained = await f.harness.snapshot(WorkflowDoc, f.root.id, context);
    expect(retained).toMatchObject({
      phase: "handoff_pending",
      plan: ready.plan,
      receipts: expect.arrayContaining([expect.objectContaining({ operationId: "approve", status: "pending" })]),
    });
    await expect(f.controller.reconcile(f.root, context)).rejects.toThrow("disposed");
    f.release.resolve();
    await competing.wait(context);
    expect((await f.harness.waitForTask(unrelated, context)).state.outcome.status).toBe("completed");
  });

  it("disposal after Harness close joins the public closed boundary and is repeatable", async () => {
    const f = await fixture();
    const ready = await f.ready();
    await f.busy();
    await f.controller.approve(f.root, { operationId: "approve", expected: f.identity(ready) }, context);
    await f.harness.close(context);
    await f.controller.dispose(context);
    await f.controller.dispose(context);
    expect((await f.harness.closed).reason).toBe("closed");
    const recovered = await f.reopen();
    cleanup.push(() => recovered.harness.close(context));
    expect((await recovered.controller.inspect(recovered.root, context)).receipts.at(-1)?.status).toBe("pending");
    expect((await recovered.harness.inspect(context)).scheduling).toBe("paused");
  });

  it("concurrent Harness close and disposal settle safely", async () => {
    const f = await fixture();
    const ready = await f.ready();
    await f.busy();
    await f.controller.approve(f.root, { operationId: "approve", expected: f.identity(ready) }, context);
    await Promise.all([f.controller.dispose(context), f.harness.close(context)]);
    expect((await f.harness.closed).reason).toBe("closed");
  });

  it("disposal after storage failure does not mask the original failure", async () => {
    const f = await fixture();
    f.storage.fail = () => true;
    await expect(f.start()).rejects.toThrow("Synthetic storage failure");
    await f.controller.dispose(context);
    await f.controller.dispose(context);
    expect(await f.harness.closed).toMatchObject({
      reason: "failed",
      error: expect.objectContaining({ message: "Synthetic storage failure" }),
    });
  });

  it("binding a closed Harness starts no work and can still be disposed", async () => {
    const f = await fixture();
    await f.harness.close(context);
    const runtime = createControllerRuntime(f.options);
    expect(runtime.getHarness()).toBeUndefined();
    const controller = runtime.bind(f.harness);
    expect(() => runtime.bind(f.harness)).toThrow("already bound");
    await controller.dispose(context);
    await expect(controller.inspect(f.root, context)).rejects.toThrow("disposed");
    expect(f.faux.state.callCount).toBe(0);
  });

  it("disposal after native placement does not abort the admitted implementation run", async () => {
    const f = await fixture();
    const ready = await f.ready();
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}, { id: "implementation" }), { stopReason: "toolUse" }),
    ]);
    await f.controller.approve(f.root, { operationId: "approve", expected: f.identity(ready) }, context);
    await f.entered.promise;
    const live = await f.harness.snapshot(LiveDoc, f.root.id, context);
    const submissionId = required(live?.run?.inputs[0]);
    await f.controller.dispose(context);
    const submission = required(await f.harness.submission(submissionId, context));
    expect((await submission.status(context)).status).toBe("placed");
    expect((await f.harness.snapshot(WorkflowDoc, f.root.id, context))?.plan).toBe(ready.plan);
    f.release.resolve();
    expect((await submission.wait(context)).status).toBe("done");
    expect(f.heldExecutions()).toBe(1);
  });

  it("discard supersedes a waiting approval without delivering the old plan", async () => {
    const f = await fixture();
    const ready = await f.ready();
    const competing = await f.busy();
    const approved = await f.controller.approve(
      f.root,
      { operationId: "approve", expected: f.identity(ready) },
      context,
    );
    const discarded = await f.controller.discard(
      f.root,
      { operationId: "discard", expected: f.identity(approved) },
      context,
    );
    expect(discarded).toMatchObject({ phase: "inactive", closing: true });
    expect(discarded.receipts.find((item) => item.operationId === "approve")).toMatchObject({
      status: "failed",
      error: "Superseded by discard before input placement",
    });
    // The predecessor can observe supersession before the host's abort mark reaches it.
    expect((await f.harness.getTask(required(approved.delivery?.taskId), context))?.state.status).toBe("terminal");
    f.release.resolve();
    await competing.wait(context);
    const settled = await f.settle("discard");
    expect(settled.closing).toBeUndefined();
    expect(settled.delivery).toBeUndefined();
    expect(settled.receipts.at(-1)?.status).toBe("done");
    expect(f.faux.state.callCount).toBe(1);
  });

  it.each(["queued", "placed", "done"] as const)(
    "discard reconciles a superseded %s native input without inventing withdrawal",
    async (placement) => {
      const f = await fixture();
      const ready = await f.ready();
      const competing = await f.busy();
      const approved = await f.controller.approve(
        f.root,
        { operationId: "approve", expected: f.identity(ready) },
        context,
      );
      const delivery = required(approved.delivery);
      await f.harness.abortTask(required(delivery.taskId), context);
      await f.harness.waitForTask(required(delivery.taskId), context);
      const exact = await f.root.submit(
        {
          type: "input",
          content: required(delivery.content),
          requestId: delivery.requestId,
          entry: {
            kind: "plan-mode.input",
            data: { workflowId: approved.workflowId, revision: delivery.revision, operationId: delivery.operationId },
          },
        },
        context,
      );
      expect((await exact.status(context)).status).toBe("queued");
      const implementing = barrier();
      const finishImplementation = barrier();
      if (placement !== "queued") {
        f.faux.setResponses([
          async () => {
            implementing.resolve();
            if (placement === "placed") await finishImplementation.promise;
            return fauxAssistantMessage("already implemented");
          },
        ]);
        f.release.resolve();
        await competing.wait(context);
        await implementing.promise;
        if (placement === "done") await exact.wait(context);
      }
      const discarded = await f.controller.discard(
        f.root,
        { operationId: "discard", expected: f.identity(approved) },
        context,
      );
      const receipt = required(discarded.receipts.find((item) => item.operationId === "approve"));
      if (placement === "queued") {
        expect(receipt).toMatchObject({ status: "failed", error: "Superseded by discard; queued input aborted" });
        expect(receipt.submissionId).toBeUndefined();
        expect(await exact.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
        expect(discarded.closing).toBe(true);
        f.release.resolve();
        await competing.wait(context);
        expect(f.faux.state.callCount).toBe(1);
      } else {
        expect(receipt).toMatchObject({ status: "done", submissionId: exact.id });
        expect(receipt.error).toBeUndefined();
        expect((await exact.status(context)).status).toBe(placement);
        if (placement === "placed") expect(discarded.closing).toBe(true);
        finishImplementation.resolve();
        await exact.wait(context);
        expect(f.faux.state.callCount).toBe(2);
      }
      const settled = await f.settle("discard");
      expect(settled.closing).toBeUndefined();
      expect(settled.capabilities).toEqual(ready.capabilities);
    },
  );

  it.each(["placed", "done"] as const)(
    "discard records %s delivery when placement wins the queued withdrawal race",
    async (placement) => {
      const f = await fixture();
      const ready = await f.ready();
      const competing = await f.busy();
      const approved = await f.controller.approve(
        f.root,
        { operationId: "approve", expected: f.identity(ready) },
        context,
      );
      const delivery = required(approved.delivery);
      await f.harness.abortTask(required(delivery.taskId), context);
      await f.harness.waitForTask(required(delivery.taskId), context);
      const exact = await f.root.submit(
        {
          type: "input",
          content: required(delivery.content),
          requestId: delivery.requestId,
          entry: {
            kind: "plan-mode.input",
            data: { workflowId: approved.workflowId, revision: delivery.revision, operationId: delivery.operationId },
          },
        },
        context,
      );
      const withdrawing = barrier();
      const releaseWithdrawal = barrier();
      const nativeAbort = f.harness.abortSubmission.bind(f.harness);
      const abort = vi.spyOn(f.harness, "abortSubmission").mockImplementation(async (...args) => {
        withdrawing.resolve();
        await releaseWithdrawal.promise;
        return nativeAbort(...args);
      });
      const discarding = f.controller.discard(
        f.root,
        { operationId: "discard", expected: f.identity(approved) },
        context,
      );
      await withdrawing.promise;
      expect((await f.harness.snapshot(WorkflowDoc, f.root.id, context))?.closing).toBe(true);
      const implementing = barrier();
      const finishImplementation = barrier();
      f.faux.setResponses([
        async () => {
          implementing.resolve();
          if (placement === "placed") await finishImplementation.promise;
          return fauxAssistantMessage("already placed");
        },
      ]);
      f.release.resolve();
      await competing.wait(context);
      await implementing.promise;
      if (placement === "done") await exact.wait(context);
      expect((await exact.status(context)).status).toBe(placement);
      releaseWithdrawal.resolve();
      const discarded = await discarding;
      expect(discarded.receipts.find((item) => item.operationId === "approve")).toMatchObject({
        status: "done",
        submissionId: exact.id,
      });
      expect(abort).toHaveBeenCalledExactlyOnceWith(exact.id, expect.anything(), f.root.id);
      expect(await abort.mock.results[0]?.value).toBe(placement === "placed" ? "already_placed" : "settled");
      abort.mockRestore();
      finishImplementation.resolve();
      await exact.wait(context);
      await f.settle("discard");
      expect(f.faux.state.callCount).toBe(2);
    },
  );

  it("discard does not withdraw a queued request ID collision", async () => {
    const f = await fixture();
    const ready = await f.ready();
    const competing = await f.busy();
    const approved = await f.controller.approve(
      f.root,
      { operationId: "approve", expected: f.identity(ready) },
      context,
    );
    await f.harness.abortTask(required(approved.delivery?.taskId), context);
    await f.harness.waitForTask(required(approved.delivery?.taskId), context);
    const unrelated = await f.root.submit(
      { type: "input", content: "unrelated queued input", requestId: approved.delivery?.requestId },
      context,
    );
    const discarded = await f.controller.discard(
      f.root,
      { operationId: "discard", expected: f.identity(approved) },
      context,
    );
    expect(discarded.receipts.find((item) => item.operationId === "approve")?.status).toBe("failed");
    expect((await unrelated.status(context)).status).toBe("queued");
    f.faux.setResponses([fauxAssistantMessage("unrelated complete")]);
    f.release.resolve();
    await competing.wait(context);
    expect((await unrelated.wait(context)).status).toBe("done");
    await f.settle("discard");
  });

  it("a cancelled mutex waiter releases its turn without passing the publishing predecessor", async () => {
    const f = await fixture();
    const publishing = barrier();
    const releasePublication = barrier();
    const caller = withCancel(context);
    const input = {
      operationId: "prompt",
      workflowId: "workflow-1",
      prompt: "exact prompt",
      expected: { workflowId: null, revision: 0 },
    };
    let publications = 0;
    f.storage.beforeCommit = async (writes) => {
      if (!writes.some((write) => write.type === "task" && write.value.kind === "plan-mode.delivery")) return;
      publications++;
      publishing.resolve();
      await releasePublication.promise;
    };
    f.faux.setResponses([fauxAssistantMessage("planning")]);
    const first = f.controller.start(f.root, input, context);
    const canceled = f.controller.start(f.root, input, caller.context).catch((error: unknown) => error);
    let successorFinished = false;
    const successor = f.controller.start(f.root, input, context).then((value) => {
      successorFinished = true;
      return value;
    });
    await publishing.promise;
    caller.cancel();
    expect(await canceled).toBeInstanceOf(Error);
    expect(successorFinished).toBe(false);
    expect(publications).toBe(1);
    releasePublication.resolve();
    await Promise.all([first, successor]);
    const settled = await f.settle("prompt");
    expect(settled.receipts.filter((receipt) => receipt.operationId === "prompt")).toHaveLength(1);
    expect(settled.receipts.at(-1)?.status).toBe("done");
  });

  it("disposal cancels mutex waiters before joining an in-flight publishing commit", async () => {
    const f = await fixture();
    const publishing = barrier();
    const releasePublication = barrier();
    const input = {
      operationId: "prompt",
      workflowId: "workflow-1",
      prompt: "do not place",
      expected: { workflowId: null, revision: 0 },
    };
    f.storage.beforeCommit = async (writes) => {
      if (!writes.some((write) => write.type === "task" && write.value.kind === "plan-mode.delivery")) return;
      publishing.resolve();
      await releasePublication.promise;
    };
    const first = f.controller.start(f.root, input, context).catch((error: unknown) => error);
    const waiting = f.controller.start(f.root, input, context).catch((error: unknown) => error);
    await publishing.promise;
    const disposing = f.controller.dispose(context);
    expect(await waiting).toBeInstanceOf(Error);
    releasePublication.resolve();
    expect(await first).toBeInstanceOf(Error);
    await disposing;
    const retained = await f.harness.snapshot(WorkflowDoc, f.root.id, context);
    expect((await f.harness.getTask(required(retained?.delivery?.taskId), context))?.state).toMatchObject({
      status: "terminal",
      outcome: { status: "aborted" },
    });
    expect(f.faux.state.callCount).toBe(0);
  });

  it("rejects fork mutations and reconciliation, then activates only a new identity", async () => {
    const f = await fixture();
    const ready = await f.ready();
    const entry = await f.root.commit((tx) => tx.appendEntry(f.root.id, { kind: "test.ready" }), context);
    const fork = await f.root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
    expect(await f.controller.inspect(fork, context)).toMatchObject({
      forked: true,
      phase: "inactive",
      plan: ready.plan,
    });
    await expect(
      f.controller.approve(fork, { operationId: "fork-approve", expected: f.identity(ready) }, context),
    ).rejects.toThrow("Fork");
    await expect(f.controller.reconcile(fork, context)).rejects.toThrow("fork");
    await expect(
      f.controller.start(
        fork,
        { operationId: "fork-start", expected: f.identity(ready), workflowId: required(ready.workflowId) },
        context,
      ),
    ).rejects.toThrow("new identity");
    const activated = await f.controller.start(
      fork,
      { operationId: "fork-start", expected: f.identity(ready), workflowId: "workflow-fork" },
      context,
    );
    expect(activated).toMatchObject({ forked: false, owner: fork.id, workflowId: "workflow-fork", phase: "planning" });
    expect((await f.controller.inspect(f.root, context)).workflowId).toBe(ready.workflowId);
    expect(f.faux.state.callCount).toBe(0);
  });

  it("cancellation before admission writes no state and cancellation after admission preserves the intent", async () => {
    const f = await fixture();
    const canceled = withCancel(context);
    canceled.cancel();
    await expect(
      f.controller.start(
        f.root,
        { operationId: "cancel", workflowId: "workflow-1", expected: { workflowId: null, revision: 0 } },
        canceled.context,
      ),
    ).rejects.toThrow();
    expect((await f.controller.inspect(f.root, context)).revision).toBe(0);
    const ready = await f.ready();
    await f.busy();
    const caller = withCancel(context);
    await f.controller.approve(f.root, { operationId: "approve", expected: f.identity(ready) }, caller.context);
    caller.cancel();
    expect((await f.controller.inspect(f.root, context)).delivery?.operationId).toBe("approve");
    await f.controller.dispose(context);
  });

  it.each([false, true])(
    "explicit reconciliation replaces a terminal or missing task reference (missing=%s)",
    async (missing) => {
      const f = await fixture();
      const ready = await f.ready();
      const competing = await f.busy();
      const input = { operationId: "approve", expected: f.identity(ready) };
      const pending = await f.controller.approve(f.root, input, context);
      const originalTask = required(pending.delivery?.taskId);
      await f.harness.abortTask(originalTask, context);
      await f.harness.waitForTask(originalTask, context);
      if (missing)
        await f.root.commit(async (tx) => {
          const state = await tx.doc(WorkflowDoc, f.root.id);
          delete required(state.delivery).taskId;
          delete required(state.receipts.at(-1)).taskId;
        }, context);
      const restarted = await f.controller.reconcile(f.root, context);
      expect(restarted.delivery?.taskId).not.toBe(originalTask);
      const once = required(restarted.delivery?.taskId);
      const repeated = await f.controller.reconcile(f.root, context);
      expect(repeated.delivery?.taskId).toBe(once);
      f.faux.setResponses([fauxAssistantMessage("implemented once")]);
      f.release.resolve();
      await competing.wait(context);
      const placed = await f.settle("approve");
      await required(await f.harness.submission(required(placed.approval?.submissionId), context)).wait(context);
      expect(
        (await f.root.context(context)).messages.filter(
          (message) => message.role === "user" && message.content === ready.plan,
        ),
      ).toHaveLength(1);
    },
  );

  it("a conflicting native request ID fails closed and remains failed after explicit retry", async () => {
    const f = await fixture();
    const ready = await f.ready();
    const competing = await f.busy();
    const pending = await f.controller.approve(
      f.root,
      { operationId: "approve", expected: f.identity(ready) },
      context,
    );
    const collision = await f.root.submit(
      { type: "input", content: required(ready.plan), requestId: pending.delivery?.requestId },
      context,
    );
    f.faux.setResponses([fauxAssistantMessage("untrusted admission")]);
    f.release.resolve();
    await competing.wait(context);
    await collision.wait(context);
    const failed = await f.settle("approve");
    expect(failed.phase).toBe("handoff_pending");
    expect(failed.approval?.submissionId).toBeUndefined();
    expect(failed.receipts.at(-1)).toMatchObject({
      status: "failed",
      error: "Plan Mode request ID identifies different input",
    });
    await f.controller.reconcile(f.root, context);
    const retried = await f.settle("approve");
    expect(retried.receipts.at(-1)?.status).toBe("failed");
    expect(f.faux.state.callCount).toBe(2);
    expect(retried.plan).toBe(ready.plan);
  });

  it("a stale revision discovered after the idle wait has no delivery effect", async () => {
    const f = await fixture();
    const ready = await f.ready();
    const competing = await f.busy();
    const pending = await f.controller.approve(
      f.root,
      { operationId: "approve", expected: f.identity(ready) },
      context,
    );
    await f.root.commit(async (tx) => {
      (await tx.doc(WorkflowDoc, f.root.id)).revision++;
    }, context);
    f.release.resolve();
    await competing.wait(context);
    const ended = await f.harness.waitForTask(required(pending.delivery?.taskId), context);
    expect(ended.state.outcome).toMatchObject({ status: "completed", result: { status: "stale" } });
    expect(f.faux.state.callCount).toBe(1);
    expect((await f.controller.inspect(f.root, context)).approval?.submissionId).toBeUndefined();
  });

  it("disposal joins a publishing host commit and aborts its newly committed task before any input", async () => {
    const f = await fixture();
    const publishing = barrier();
    const releasePublication = barrier();
    f.storage.beforeCommit = async (writes) => {
      if (!writes.some((write) => write.type === "task" && write.value.kind === "plan-mode.delivery")) return;
      publishing.resolve();
      await releasePublication.promise;
      f.storage.beforeCommit = undefined;
    };
    const admission = f.controller
      .start(
        f.root,
        {
          operationId: "prompt",
          workflowId: "workflow-1",
          prompt: "Do not submit after disposal",
          expected: { workflowId: null, revision: 0 },
        },
        context,
      )
      .catch((error: unknown) => error);
    await publishing.promise;
    const disposal = f.controller.dispose(context);
    releasePublication.resolve();
    expect(await admission).toBeInstanceOf(Error);
    await disposal;
    const retained = await f.harness.snapshot(WorkflowDoc, f.root.id, context);
    const task = await f.harness.getTask(required(retained?.delivery?.taskId), context);
    expect(task?.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
    expect(f.faux.state.callCount).toBe(0);
    expect((await f.root.context(context)).messages.filter((message) => message.role === "user")).toEqual([]);
  });

  it("a host storage failure publishes neither the workflow transition nor its task", async () => {
    const f = await fixture();
    f.storage.fail = () => true;
    await expect(f.start()).rejects.toThrow("Synthetic storage failure");
    await f.harness.close(context);
    const recovered = await f.reopen();
    cleanup.push(() => recovered.harness.close(context));
    expect((await recovered.controller.inspect(recovered.root, context)).revision).toBe(0);
    expect((await recovered.harness.inspect(context)).tasks).toEqual([]);
    expect(
      (
        await recovered.controller.start(
          recovered.root,
          {
            operationId: "retry",
            workflowId: "workflow-1",
            expected: { workflowId: null, revision: 0 },
          },
          context,
        )
      ).phase,
    ).toBe("planning");
  });

  it("reconciles a failed placement checkpoint without submitting another kickoff", async () => {
    const f = await fixture();
    const ready = await f.ready();
    f.faux.setResponses([fauxAssistantMessage("implemented once")]);
    f.storage.fail = (writes) =>
      writes.some(
        (write) =>
          write.type === "task" && write.value.kind === "plan-mode.delivery" && write.value.state.status === "terminal",
      );
    const admission = f.controller
      .approve(f.root, { operationId: "approve", expected: f.identity(ready) }, context)
      .catch(() => undefined);
    await f.storage.failure.promise;
    await admission;
    await f.harness.close(context);
    const recovered = await f.reopen();
    cleanup.push(() => recovered.harness.close(context));
    const failed = await recovered.controller.inspect(recovered.root, context);
    expect(failed).toMatchObject({ plan: ready.plan, phase: "handoff_pending" });
    expect(failed.receipts.at(-1)).toMatchObject({ status: "pending" });
    await recovered.controller.reconcile(recovered.root, context);
    await recovered.harness.waitForTask(required(failed.receipts.at(-1)?.taskId), context);
    const completed = await recovered.controller.inspect(recovered.root, context);
    expect(completed.phase).toBe("implementing");
    expect(completed.receipts.at(-1)?.status).toBe("done");
    await recovered.root.waitForIdle(context);
    expect(
      (await recovered.root.context(context)).messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual([ready.plan]);
    expect(f.faux.state.callCount).toBe(1);
  });

  it("binds before recovery and inspection does not resume a closed pending handoff", async () => {
    const f = await fixture();
    const ready = await f.ready();
    await f.busy();
    await f.controller.approve(f.root, { operationId: "approve", expected: f.identity(ready) }, context);
    await f.harness.close(context);
    const { harness: reopened, controller, root } = await f.reopen();
    cleanup.push(() => reopened.close(context));
    expect((await controller.inspect(root, context)).phase).toBe("handoff_pending");
    expect((await reopened.inspect(context)).scheduling).toBe("paused");
    expect(f.heldExecutions()).toBe(1);
    f.faux.setResponses([fauxAssistantMessage("implemented after reopen")]);
    f.release.resolve();
    await controller.reconcile(root, context);
    const pending = await controller.inspect(root, context);
    await reopened.waitForTask(required(pending.receipts.at(-1)?.taskId), context);
    const placed = await controller.inspect(root, context);
    expect(placed.phase).toBe("implementing");
    await required(await reopened.submission(required(placed.approval?.submissionId), context)).wait(context);
    expect(
      (await root.context(context)).messages.filter(
        (message) => message.role === "user" && message.content === ready.plan,
      ),
    ).toHaveLength(1);
  });
});
