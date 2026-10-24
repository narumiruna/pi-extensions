// Synthetic Models and IPC worker for production-backend tests. No fixture runtime or effect tools.
import { awaitWithContext, BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import { type DurableProfile, DurableSubagentRuntime } from "../src/durable-runtime.js";

export type Checkpoint = (name: string, context: Context) => Promise<void>;
export function runtimeModels(checkpoint: Checkpoint = async () => {}) {
  const models = createModels();
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  models.setProvider(faux.provider);
  const requests: { messages: unknown[]; systemPrompt: string; tools: unknown[] }[] = [];
  faux.setResponses(
    Array.from({ length: 100 }, () => async (request, options) => {
      requests.push({
        messages: structuredClone(request.messages),
        systemPrompt: getCurrentSystemPrompt(request.messages),
        tools: getCurrentTools(request.messages).map(toToolDeclaration),
      });
      const user = [...request.messages].reverse().find((message) => message.role === "user");
      const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
      await checkpoint(
        `generation:${text}`,
        withAbortSignal(options?.signal ?? new AbortController().signal, BACKGROUND_CONTEXT),
      );
      const last = request.messages.at(-1);
      if (text?.startsWith("read:") && last?.role === "user") {
        return fauxAssistantMessage([fauxToolCall("read", { path: text.slice(5) }, { id: "native-read-call" })], {
          stopReason: "toolUse",
        });
      }
      if (last?.role === "toolResult") return fauxAssistantMessage(JSON.stringify(last.content));
      if (text === "fail")
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic provider failure" });
      return fauxAssistantMessage(`answer:${text}`);
    }),
  );
  return { models, faux, requests, model: { provider: faux.provider.id, modelId: faux.getModel().id } };
}

if (process.argv[2] === "--durable-runtime-worker") {
  const directory = process.argv[3];
  if (!directory || !process.send) throw new Error("Runtime worker requires a directory and IPC");
  const blocks = new Set<string>(JSON.parse(process.argv[4] ?? "[]"));
  const releases = new Map<string, Set<() => void>>();
  const send = (frame: unknown) => {
    if (process.connected) process.send?.(frame, () => {});
  };
  const checkpoint: Checkpoint = async (name, context) => {
    let release: (() => void) | undefined;
    const blocked = blocks.has(name)
      ? new Promise<void>((resolve) => {
          release = resolve;
          const waiters = releases.get(name) ?? new Set<() => void>();
          releases.set(name, waiters);
          waiters.add(resolve);
        })
      : undefined;
    send({ event: name });
    if (blocked) {
      try {
        await awaitWithContext(blocked, context);
      } finally {
        if (release) releases.get(name)?.delete(release);
      }
    }
  };
  const fixture = runtimeModels(checkpoint);
  const profile: DurableProfile = {
    model: fixture.model,
    thinkingLevel: "off",
    tools: ["read"],
    cwd: directory,
    trusted: true,
  };
  const runtime = await DurableSubagentRuntime.open({
    directory,
    binding: "main:branch",
    models: fixture.models,
    authorize: async () => {},
    checkpoint,
  });
  process.on(
    "message",
    (command: {
      id: number;
      op: string;
      conversationId?: string;
      requestId?: string;
      task?: string;
      checkpoint?: string;
      timeoutMs?: number | null;
    }) => {
      void (async () => {
        switch (command.op) {
          case "spawn":
            return runtime.spawn(
              command.requestId ?? "tool-spawn",
              command.task ?? "A",
              profile,
              command.timeoutMs ?? null,
            );
          case "send":
            return runtime.send(
              command.conversationId ?? "",
              command.requestId ?? "tool-send",
              command.task ?? "B",
              "followUp",
            );
          case "stop":
            return runtime.stop(command.conversationId ?? "", command.requestId ?? "tool-stop");
          case "state":
            return runtime.state();
          case "model-calls":
            return fixture.faux.state.callCount;
          case "wait":
            return runtime.wait(command.conversationId ?? "", 1000);
          case "resume":
            runtime.resume();
            return null;
          case "release":
            blocks.delete(command.checkpoint ?? "");
            for (const release of releases.get(command.checkpoint ?? "") ?? []) release();
            return null;
          case "shutdown":
            await runtime.shutdown();
            return null;
          default:
            throw new Error("Unknown runtime worker operation");
        }
      })().then(
        (value) => send({ id: command.id, value }),
        (error: unknown) => send({ id: command.id, error: String(error) }),
      );
    },
  );
  process.once("disconnect", () => {
    void runtime.shutdown();
  });
  send({ event: "ready" });
}
