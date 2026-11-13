import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  formatPage,
  getPage,
  listPages,
  resolvePage,
  resolvePageForNavigation,
  setActivePageId,
  textResult,
  withCdp,
} from "./cdp-client.js";
import { renderScreenshotResult, renderTextResult, renderToolCall, withStatus } from "./render.js";
import { formatScreenshotText, saveScreenshot, throwIfAborted } from "./screenshot.js";
import { CHROME_DEVTOOLS_TOOL_NAMES, WEBMCP_TOOL_NAMES } from "./tool-names.js";

export const listPagesTool = defineTool({
  name: CHROME_DEVTOOLS_TOOL_NAMES[0],
  label: "Chrome DevTools: List Pages",
  description: "List Chrome tabs/pages from a running Chrome DevTools Protocol endpoint.",
  parameters: Type.Object({}),
  renderCall: renderToolCall("list pages"),
  renderResult: renderTextResult,
  async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "list pages", async () => {
      const pages = await listPages({ sessionOwner: ctx.sessionManager, signal });
      return textResult(JSON.stringify(pages.map(formatPage), null, 2), { pages });
    });
  },
});

export const selectPageTool = defineTool({
  name: CHROME_DEVTOOLS_TOOL_NAMES[1],
  label: "Chrome DevTools: Select Page",
  description: "Select the active Chrome page for later chrome_devtools_* tool calls.",
  parameters: Type.Object({
    pageId: Type.String({ description: "Page id from chrome_devtools_list_pages." }),
  }),
  renderCall: renderToolCall("select page"),
  renderResult: renderTextResult,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "select page", async () => {
      const page = await getPage(params.pageId, { sessionOwner: ctx.sessionManager, signal });
      setActivePageId(ctx.sessionManager, page.id);
      return textResult(`Selected page ${page.id}: ${page.title}\n${page.url}`, {
        page: formatPage(page),
      });
    });
  },
});

export const navigateTool = defineTool({
  name: CHROME_DEVTOOLS_TOOL_NAMES[2],
  label: "Chrome DevTools: Navigate",
  description:
    "Navigate a Chrome page to a URL through Chrome DevTools Protocol, creating a page first if none is available.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to navigate to." }),
    pageId: Type.Optional(Type.String({ description: "Optional page id. Defaults to selected or first page." })),
  }),
  renderCall: renderToolCall("navigate"),
  renderResult: renderTextResult,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "navigate", async () => {
      const { created, page } = await resolvePageForNavigation(params.pageId, {
        sessionOwner: ctx.sessionManager,
        signal,
      });
      const result = await withCdp(page, async (client) => {
        await client.send("Page.enable");
        return client.send("Page.navigate", { url: params.url });
      });

      setActivePageId(ctx.sessionManager, page.id);
      const action = created ? "Created page and navigated" : "Navigated";
      return textResult(`${action} ${page.id} to ${params.url}`, {
        created,
        page: formatPage(page),
        result,
      });
    });
  },
});

export const evaluateTool = defineTool({
  name: CHROME_DEVTOOLS_TOOL_NAMES[3],
  label: "Chrome DevTools: Evaluate",
  description: "Evaluate JavaScript in a Chrome page through Chrome DevTools Protocol.",
  parameters: Type.Object({
    expression: Type.String({ description: "JavaScript expression to evaluate." }),
    pageId: Type.Optional(Type.String({ description: "Optional page id. Defaults to selected or first page." })),
    awaitPromise: Type.Optional(
      Type.Boolean({ description: "Whether to await a returned Promise. Defaults to true." }),
    ),
  }),
  renderCall: renderToolCall("evaluate"),
  renderResult: renderTextResult,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "evaluate", async () => {
      const page = await resolvePage(params.pageId, {
        sessionOwner: ctx.sessionManager,
        signal,
      });
      const result = await withCdp(page, (client) =>
        client.send("Runtime.evaluate", {
          expression: params.expression,
          awaitPromise: params.awaitPromise ?? true,
          returnByValue: true,
        }),
      );

      setActivePageId(ctx.sessionManager, page.id);
      return textResult(JSON.stringify(result, null, 2), { page: formatPage(page), result });
    });
  },
});

export const webMcpListToolsTool = defineTool({
  name: WEBMCP_TOOL_NAMES[0],
  label: "Chrome DevTools: List WebMCP Tools (Experimental)",
  description:
    "List bounded page-provided WebMCP tool descriptors from the selected Chrome page through the experimental CDP WebMCP domain. Definitions remain in this tool result and are never registered as dynamic Pi tools.",
  parameters: Type.Object({
    pageId: Type.Optional(
      Type.String({
        description: "Optional page id. Defaults to selected or first page.",
        maxLength: 512,
      }),
    ),
  }),
  renderCall: renderToolCall("list WebMCP tools"),
  renderResult: renderTextResult,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "list WebMCP tools", async () => {
      const implementation = await import("./webmcp/tools.js");
      return implementation.executeWebMcpListTool(params, signal, ctx);
    });
  },
});

export const webMcpCallTool = defineTool({
  name: WEBMCP_TOOL_NAMES[1],
  label: "Chrome DevTools: Call WebMCP Tool (Experimental)",
  description:
    "Call one previously listed page-provided WebMCP tool after exact page, document, frame, origin, schema, annotation, and session revalidation. Every call requires observable user confirmation and output is bounded to Pi's 50 KB or 2,000-line limit.",
  parameters: Type.Object({
    sessionGeneration: Type.String({
      description: "Session generation token returned by chrome_devtools_webmcp_list_tools.",
      maxLength: 100,
    }),
    pageId: Type.String({ description: "Page id returned by the list tool.", maxLength: 512 }),
    documentId: Type.String({
      description: "Document loader id returned by the list tool.",
      maxLength: 512,
    }),
    frameId: Type.String({ description: "Frame id returned by the list tool.", maxLength: 512 }),
    frameOrigin: Type.String({
      description: "Exact frame origin returned by the list tool.",
      maxLength: 2_048,
    }),
    toolName: Type.String({
      description: "Exact tool name returned by the list tool.",
      maxLength: 512,
    }),
    schemaDigest: Type.String({
      description: "Schema and annotation digest returned by the list tool.",
      minLength: 64,
      maxLength: 64,
      pattern: "^[a-f0-9]{64}$",
    }),
    input: Type.Record(Type.String(), Type.Unknown(), {
      description: "JSON object matching the page-provided input schema.",
    }),
  }),
  renderCall: renderToolCall("call WebMCP tool"),
  renderResult: renderTextResult,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "call WebMCP tool", async () => {
      const implementation = await import("./webmcp/tools.js");
      return implementation.executeWebMcpCallTool(params, signal, ctx);
    });
  },
});

export const screenshotTool = defineTool({
  name: CHROME_DEVTOOLS_TOOL_NAMES[4],
  label: "Chrome DevTools: Screenshot",
  description: "Capture a PNG screenshot from a Chrome page through Chrome DevTools Protocol.",
  parameters: Type.Object({
    pageId: Type.Optional(Type.String({ description: "Optional page id. Defaults to selected or first page." })),
    fullPage: Type.Optional(Type.Boolean({ description: "Capture the full document, not just the viewport." })),
    savePath: Type.Optional(
      Type.String({
        description:
          "Screenshot is always saved as a PNG file. Optional output path; omitted defaults to a unique temp file. Relative paths resolve from the current working directory. A single leading @ is stripped to match Pi file-mention paths. Existing regular files are replaced.",
      }),
    ),
  }),
  renderCall: renderToolCall("screenshot"),
  renderResult: renderScreenshotResult,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "screenshot", async () => {
      const page = await resolvePage(params.pageId, {
        sessionOwner: ctx.sessionManager,
        signal,
      });
      const result = await withCdp(page, async (client) => {
        throwIfAborted(signal);
        await client.send("Page.enable");

        if (!params.fullPage) {
          return client.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
        }

        const metrics = await client.send<{
          contentSize: { x: number; y: number; width: number; height: number };
        }>("Page.getLayoutMetrics");

        throwIfAborted(signal);
        return client.send<{ data: string }>("Page.captureScreenshot", {
          captureBeyondViewport: true,
          format: "png",
          clip: {
            x: metrics.contentSize.x,
            y: metrics.contentSize.y,
            width: metrics.contentSize.width,
            height: metrics.contentSize.height,
            scale: 1,
          },
        });
      });

      setActivePageId(ctx.sessionManager, page.id);
      const savedScreenshot = await saveScreenshot(result.data, params.savePath, ctx.cwd, signal);
      return {
        content: [
          {
            type: "text",
            text: formatScreenshotText(page, savedScreenshot),
          },
          { type: "image", data: result.data, mimeType: "image/png" },
        ],
        details: {
          page: formatPage(page),
          bytes: savedScreenshot.bytes,
          savedPath: savedScreenshot.savedPath,
          isDefaultPath: savedScreenshot.isDefaultPath,
        },
      };
    });
  },
});
