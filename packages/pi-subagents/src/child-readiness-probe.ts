import * as fs from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { toolSourceId } from "./attachment-utils.js";
import { type ChildSelection, MAX_READINESS_FRAME_BYTES, takeCapturedReadiness } from "./broker-credentials.js";
import { type ChildReadinessFrame, isChildModelPair } from "./child-readiness.js";

export interface ChildReadinessState {
  fd: number;
  expectedTools: string[];
  selection: ChildSelection;
}

const captured = takeCapturedReadiness();

const childReadinessProbe: ExtensionFactory = captured ? createChildReadinessProbe(captured) : () => undefined;

export default childReadinessProbe;

class ReadinessError extends Error {}

export function createChildReadinessProbe(
  readiness: ChildReadinessState,
  writeFrame: (fd: number, frame: string) => void = writeReadinessFrame,
  close: (fd: number) => void = closeDescriptor,
): ExtensionFactory {
  return (pi) => {
    let settled = false;
    let started = false;
    let controller: AbortController | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const publish = (value: ChildReadinessFrame) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      controller?.abort();
      let frame = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(frame, "utf8") > MAX_READINESS_FRAME_BYTES) {
        frame = `${JSON.stringify({ ok: false, error: "Subagent readiness frame exceeded its size limit." })}\n`;
      }
      try {
        writeFrame(readiness.fd, frame);
      } finally {
        close(readiness.fd);
      }
    };
    const toolState = () => {
      const active = pi.getActiveTools();
      const missing = readiness.expectedTools.filter((tool) => !active.includes(tool));
      if (missing.length > 0) {
        throw new ReadinessError(`Unavailable subagent tools: ${missing.join(", ").slice(0, 512)}.`);
      }
      const all = new Map(pi.getAllTools().map((tool) => [tool.name, tool.sourceInfo.path]));
      const sources = readiness.expectedTools.map((tool) => {
        const source = all.get(tool);
        if (!source) throw new ReadinessError("Subagent child tool provenance is unavailable.");
        return toolSourceId(source);
      });
      return { active, sources };
    };

    pi.on("resources_discover", async (_event, ctx) => {
      if (settled || started) return;
      started = true;
      controller = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
      deadline = setTimeout(() => publish({ ok: false, error: "Subagent child model readiness timed out." }), 30_000);
      deadline.unref();
      try {
        const tools = toolState();
        const initialModel = ctx.model;
        const initialDefinition = JSON.stringify(initialModel);
        const pair = { provider: readiness.selection.provider, id: readiness.selection.model };
        const registry = ctx.modelRegistry;
        const manager = ctx.sessionManager;
        const sessionId = manager.getSessionId();
        const cwd = ctx.cwd;
        const trusted = ctx.isProjectTrusted();
        const nativeProvider = registry.getRegisteredNativeProvider(pair.provider);
        const providerConfig = registry.getRegisteredProviderConfig(pair.provider);
        const assertContext = () => {
          signal.throwIfAborted();
          if (
            ctx.modelRegistry !== registry ||
            ctx.sessionManager !== manager ||
            manager.getSessionId() !== sessionId ||
            ctx.cwd !== cwd ||
            ctx.isProjectTrusted() !== trusted ||
            registry.getRegisteredNativeProvider(pair.provider) !== nativeProvider ||
            registry.getRegisteredProviderConfig(pair.provider) !== providerConfig ||
            JSON.stringify(toolState()) !== JSON.stringify(tools)
          )
            throw new ReadinessError("Subagent child context changed during model readiness.");
        };
        const assertInitialModel = () => {
          assertContext();
          if (ctx.model !== initialModel || JSON.stringify(ctx.model) !== initialDefinition) {
            throw new ReadinessError("Subagent child context changed during model readiness.");
          }
        };
        // The public setter checks the configured-auth snapshot before checking fresh auth.
        // Refresh it without network access; refresh can recompose registered model objects.
        await registry.refresh({ providers: [pair.provider], allowNetwork: false, signal });
        if (settled) return;
        assertInitialModel();
        const registration = registry.find(pair.provider, pair.id);
        if (!registration) {
          throw new ReadinessError("Subagent child model is not registered as an exact chat model.");
        }
        const registeredDefinition = JSON.stringify(registration);
        const assertRegistration = () => {
          if (JSON.stringify(registry.find(pair.provider, pair.id)) !== registeredDefinition) {
            throw new ReadinessError("Subagent child registration changed during model readiness.");
          }
        };
        // Use a fresh provider-scoped availability check, not the cached chat snapshot.
        const available = await registry.getAvailableOfType("chat", pair.provider, { signal });
        if (settled) return;
        assertInitialModel();
        assertRegistration();
        if (!available.some((entry) => entry.provider === pair.provider && entry.id === pair.id)) {
          throw new ReadinessError(
            "Subagent child model is unavailable as an exact chat model with current credentials.",
          );
        }
        // CLI matching is not literal. Bind only the exact available registration before any task.
        // setModel has no signal; the parent startup deadline terminates the isolated child.
        let selectedModel = ctx.model;
        if (
          !isChildModelPair(selectedModel) ||
          selectedModel.provider !== pair.provider ||
          selectedModel.id !== pair.id ||
          JSON.stringify(selectedModel) !== registeredDefinition
        ) {
          const selected = await pi.setModel(registration);
          if (settled) return;
          assertContext();
          assertRegistration();
          if (!selected) throw new ReadinessError("Subagent child could not select the exact requested model.");
          selectedModel = registration;
        }
        const assertSelected = () => {
          assertContext();
          assertRegistration();
          const model = ctx.model;
          if (
            model !== selectedModel ||
            !isChildModelPair(model) ||
            model.provider !== pair.provider ||
            model.id !== pair.id ||
            JSON.stringify(model) !== registeredDefinition
          )
            throw new ReadinessError("Subagent child model changed during exact initial selection.");
        };
        assertSelected();
        // setModel applies model/global defaults and awaits model_select hooks. Restore the request
        // only after verifying their result; Pi clamps it to this exact model's capabilities.
        pi.setThinkingLevel(readiness.selection.thinkingLevel);
        assertSelected();
        // Selection hooks can change credentials or filters without replacing registration. Include
        // synchronous thinking hooks; Pi does not await their later asynchronous continuations.
        const availableAfterSelection = await registry.getAvailableOfType("chat", pair.provider, { signal });
        if (settled) return;
        assertSelected();
        if (!availableAfterSelection.some((entry) => entry.provider === pair.provider && entry.id === pair.id)) {
          throw new ReadinessError(
            "Subagent child model is unavailable as an exact chat model with current credentials.",
          );
        }
        publish({ ok: true, sources: tools.sources, model: pair });
      } catch (error) {
        // Provider/auth errors can contain secrets and paths. Publish only bounded probe-owned diagnostics.
        publish({
          ok: false,
          error: error instanceof ReadinessError ? error.message : "Subagent child model readiness failed.",
        });
      } finally {
        if (deadline) clearTimeout(deadline);
        controller.abort();
      }
    });

    pi.on("session_shutdown", () => {
      publish({ ok: false, error: "Subagent child shut down before readiness completed." });
    });
  };
}

function writeReadinessFrame(fd: number, frame: string): void {
  fs.writeFileSync(fd, frame, "utf8");
}

function closeDescriptor(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // The descriptor may already be closed after a failed write.
  }
}
