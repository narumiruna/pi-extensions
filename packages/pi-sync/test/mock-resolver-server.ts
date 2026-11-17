import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { type ExtensionContext, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DaemonConnection, ensureDaemon, modelSignature } from "@narumitw/pi-sync-daemon";
import type { AgentEvidence } from "@narumitw/pi-sync-daemon/engine/sync/agent-candidate";

/** An independently configured, loopback-only provider usable by a real daemon process. */
export class MockResolverServer {
  readonly requests: AgentEvidence[] = [];
  private server = createServer((request, response) => {
    void this.handle(request, response).catch(() => response.destroy());
  });
  private endpoint = "";
  constructor(private readonly reply: (evidence: AgentEvidence, signal: AbortSignal) => string | Promise<string>) {}
  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    this.endpoint = `http://127.0.0.1:${address.port}/v1`;
  }
  async configure(root: string, ctx: ExtensionContext) {
    await fs.writeFile(
      path.join(root, "models.json"),
      JSON.stringify({
        providers: {
          "sync-fixture": {
            baseUrl: this.endpoint,
            api: "openai-completions",
            apiKey: "fixture-model-key",
            models: [
              {
                id: "resolver",
                name: "Synthetic resolver",
                reasoning: false,
                input: ["text"],
                contextWindow: 32768,
                maxTokens: 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
      { mode: 0o600 },
    );
    const runtime = await ModelRuntime.create({
      authPath: path.join(root, "auth.json"),
      modelsPath: path.join(root, "models.json"),
      refreshOnCreate: false,
    });
    await runtime.refresh({ allowNetwork: false, providers: ["sync-fixture"] });
    const model = runtime.getModel("sync-fixture", "resolver");
    assert.ok(model);
    assert.equal(runtime.getProviderAuthStatus(model.provider).source, "models_json_key");
    Object.assign(ctx, { model, modelRegistry: new ModelRegistry(runtime) });
  }
  async handover(root: string, ctx: ExtensionContext) {
    const daemon = await ensureDaemon(root);
    assert.ok(ctx.model);
    const client = await new DaemonConnection(
      daemon.paths,
      daemon.identity,
      {
        id: randomUUID(),
        generation: randomUUID(),
        pid: process.pid,
        cwd: ctx.cwd,
        mode: "rpc",
        hasUI: true,
        idle: false,
        sessionDir: ctx.sessionManager.getSessionDir?.(),
        model: {
          provider: ctx.model.provider,
          id: ctx.model.id,
          signature: modelSignature(ctx.model),
          authSource: "models_json_key",
        },
      },
      {
        callback: async (callback) => {
          assert.equal(callback.kind, "confirm");
          return true; // Deliberate reviewed fixture adoption.
        },
      },
    ).attach();
    try {
      await client.run("daemon.handover", {});
    } finally {
      await client.dispose();
    }
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (
      request.method !== "POST" ||
      request.url !== "/v1/chat/completions" ||
      request.headers.authorization !== "Bearer fixture-model-key"
    ) {
      response.writeHead(400);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 2 * 1024 * 1024) throw new Error("Synthetic request exceeded its bound.");
      chunks.push(buffer);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages: { role: string; content: string | { type: string; text?: string }[] }[];
    };
    const user = body.messages.filter((message) => message.role === "user").at(-1);
    assert.ok(user);
    const content =
      typeof user.content === "string" ? user.content : user.content.map((part) => part.text ?? "").join("");
    const evidence = JSON.parse(content) as AgentEvidence;
    assert.ok(Array.isArray(evidence.units));
    this.requests.push(evidence);
    const controller = new AbortController();
    response.once("close", () => controller.abort(new DOMException("Provider client disconnected", "AbortError")));
    const result = await this.reply(evidence, controller.signal);
    if (controller.signal.aborted) return;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id: "synthetic-response", object: "chat.completion.chunk", created: 1, model: "resolver" };
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: result }, finish_reason: null }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }
}
