import { createServer } from "node:http";
import { createModels, createProvider, hasApi, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { context } from "./durable-fixture.js";
import { probeHostModels } from "./durable-host-models.js";

const Counts = defineDoc<{ admissions: number; receipts: number }>({
  kind: "test.host-transport-counts",
  version: 1,
  scope: "session",
  initial: () => ({ admissions: 0, receipts: 0 }),
});

// This is a failed-gate characterization, NOT a supported provider profile.
// It uses a local HTTP responder, dummy credentials, and no AWS endpoint.
it("one admitted Models operation can make multiple Bedrock HTTP attempts despite maxRetries zero", async () => {
  let physicalRequests = 0;
  let injectedFetchCalls = 0;
  const forwardedRetries: (number | undefined)[] = [];
  const server = createServer((request, response) => {
    request.resume();
    physicalRequests++;
    response.writeHead(503, {
      "content-type": "application/json",
      "x-amzn-errortype": "ServiceUnavailableException",
    });
    response.end(JSON.stringify({ message: "synthetic local service failure" }));
  });
  const previousAttempts = process.env.AWS_MAX_ATTEMPTS;
  const previousMode = process.env.AWS_RETRY_MODE;
  let harness: Harness | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing local server address");
    // SDK infrastructure settings are scoped to this test and restored below.
    // The Models wrapper must not mistake maxRetries:0 for overriding them.
    process.env.AWS_MAX_ATTEMPTS = "2";
    process.env.AWS_RETRY_MODE = "standard";
    const moduleName = "@earendil-works/pi-ai/providers/amazon-bedrock";
    const { amazonBedrockProvider } = (await import(
      moduleName
    )) as typeof import("@earendil-works/pi-ai/providers/amazon-bedrock");
    const native = amazonBedrockProvider();
    const original = native.getModels()[0];
    if (original === undefined) throw new Error("Missing synthetic Bedrock model configuration");
    const model = { ...original, baseUrl: `http://127.0.0.1:${address.port}` };
    const requestOptions = (options?: ModelsSimpleStreamOptions): ModelsSimpleStreamOptions => {
      forwardedRetries.push(options?.maxRetries);
      return {
        ...options,
        env: {
          AWS_PROFILE: "",
          AWS_REGION: "us-east-1",
          AWS_BEDROCK_SKIP_AUTH: "1",
          AWS_BEDROCK_FORCE_HTTP1: "1",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          NO_PROXY: "*",
        },
        fetch: async () => {
          injectedFetchCalls++;
          return new Response("synthetic fetch failure", { status: 503 });
        },
      };
    };
    const underlying = createModels();
    underlying.setProvider(
      createProvider({
        id: native.id,
        name: "Loopback-only Bedrock transport probe",
        auth: { apiKey: { name: "Synthetic loopback", resolve: async () => ({ auth: {} }) } },
        models: [model],
        api: {
          stream: (target, input, options) => {
            if (!hasApi(target, "bedrock-converse-stream")) throw new Error("Unexpected local test model API");
            return native.stream(target, input, requestOptions(options));
          },
          streamSimple: (target, input, options) => {
            if (!hasApi(target, "bedrock-converse-stream")) throw new Error("Unexpected local test model API");
            return native.streamSimple(target, input, requestOptions(options));
          },
        },
      }),
    );
    const guarded = probeHostModels(underlying, async () => {
      if (harness === undefined) throw new Error("Harness not attached");
      await harness.commit(async (tx) => {
        (await tx.doc(Counts)).admissions++;
      }, context);
      return {
        finish: async () => {
          if (harness === undefined) throw new Error("Harness not attached");
          await harness.commit(async (tx) => {
            (await tx.doc(Counts)).receipts++;
          }, context);
        },
      };
    });
    harness = await Harness.open(
      new MemoryStorage(),
      {
        models: guarded,
        registry: createRegistry(),
        settings: { retry: { enabled: false }, compaction: { enabled: false, backgroundTokens: 0 } },
      },
      context,
    );
    const root = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const submitted = await root.submit({ type: "input", content: "Synthetic transport probe" }, context);
    const settled = await submitted.wait(context);
    expect(settled.status).toBe("unanswered");
    expect(await harness.snapshot(Counts, context)).toEqual({ admissions: 1, receipts: 1 });
    expect(forwardedRetries).toEqual([0]);
    expect(physicalRequests).toBe(2);
    expect(injectedFetchCalls).toBe(0);
  } finally {
    try {
      await harness?.close(context);
    } finally {
      try {
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
      } finally {
        if (previousAttempts === undefined) delete process.env.AWS_MAX_ATTEMPTS;
        else process.env.AWS_MAX_ATTEMPTS = previousAttempts;
        if (previousMode === undefined) delete process.env.AWS_RETRY_MODE;
        else process.env.AWS_RETRY_MODE = previousMode;
      }
    }
  }
});
