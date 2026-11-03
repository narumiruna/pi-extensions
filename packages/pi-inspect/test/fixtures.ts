import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Tool } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createCodemodeExtension,
  createEditTool,
  createReadTool,
  type ExtensionAPI,
  SessionManager,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export function fixture() {
  const manager = SessionManager.inMemory("/fixture");
  const system = manager.appendMessage({
    role: "system",
    content: "",
    sections: { preamble: "base", rules: "original" },
    toolsAdded: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
    timestamp: 1,
  });
  const user = manager.appendMessage({
    role: "user",
    content: "first request <script>alert(1)</script>",
    timestamp: 2,
  });
  const assistant = manager.appendMessage(
    fauxAssistantMessage([
      fauxToolCall(
        "codemode",
        { code: 'await tools.read({path:"/skills/example/SKILL.md"}); text("done")' },
        { id: "parent" },
      ),
    ]),
  );
  const result = manager.appendMessage({
    role: "toolResult",
    toolCallId: "parent",
    toolName: "codemode",
    isError: false,
    timestamp: 3,
    content: [{ type: "text", text: "Script completed\nOutput: done" }],
    nestedCalls: {
      calls: [
        { id: "parent/1", name: "read", status: "ok", arguments: { path: "/skills/example/SKILL.md" }, durationMs: 3 },
      ],
      complete: true,
    },
  });
  manager.branch(user);
  const alternate = manager.appendMessage({ role: "user", content: "alternate branch", timestamp: 4 });
  manager.branch(result);
  const delta = manager.appendMessage({
    role: "system",
    content: "",
    sections: { rules: "changed" },
    toolsRemoved: [{ name: "read" }],
    timestamp: 5,
  });
  manager.appendContextEdit(user, { content: "edited for context only" });
  const compact = manager.appendCompaction("summary", assistant, 1000);
  const leaf = manager.appendMessage({ role: "user", content: "after compaction", timestamp: 6 });
  manager.appendLabelChange(alternate, "Alternative");
  manager.appendCustomEntry("future-state", { unknown: true });
  return { manager, system, user, assistant, result, alternate, delta, compact, leaf };
}
// Exercise Pi's public factory and loadout hook instead of maintaining a copy of
// its Codemode description formatter. No tool executor or session action is called.
export function runtimeToolDeclarations(): Tool[] {
  const registered: ToolDefinition[] = [];
  const api = {
    registerTool: (tool: ToolDefinition) => {
      registered.push(tool);
    },
  } as ExtensionAPI;
  createCodemodeExtension({ mode: "on", models: false, inlineBudget: 3000 })(api);
  const codemode = registered.find((tool) => tool.name === "codemode");
  const edit = createEditTool("/fixture");
  // The loadout is heterogeneous; this fixture reads declarations and never calls executors.
  // biome-ignore lint/suspicious/noExplicitAny: erase individual parameter types only at the test loadout boundary.
  const declared: AgentTool<any>[] = [
    createReadTool("/fixture"),
    createBashTool("/fixture"),
    edit,
    { ...edit, name: "$custom-tool", outputSchema: Type.Array(Type.String()) },
  ];
  const changes = codemode?.prepareLoadout?.({
    declared,
    callable: declared,
    registered: declared,
    getExposure: () => "direct",
    getNamespace: () => undefined,
    getPromptGuidelines: () => [],
  });
  if (!changes?.descriptions) throw Error("Missing Pi Codemode descriptions");
  return declared.map((tool) => ({
    name: tool.name,
    description: changes.descriptions?.[tool.name] ?? tool.description,
    parameters: tool.parameters,
  }));
}

export const skills = [{ name: "example", path: "/skills/example/SKILL.md", description: "Example skill" }];
export const tools: ToolInfo[] = [
  {
    name: "read",
    description: "Read",
    parameters: Type.Object({ path: Type.String() }),
    exposure: "direct",
    sourceInfo: { source: "test", path: "/fixture", scope: "temporary", origin: "top-level" },
  },
  {
    name: "mcp__docs__search",
    description: "Search",
    parameters: Type.Object({ query: Type.String() }),
    exposure: "codemode",
    namespace: { name: "mcp__docs" },
    sourceInfo: { source: "test", path: "/fixture", scope: "temporary", origin: "top-level" },
  },
  {
    name: "hidden",
    description: "Hidden",
    parameters: Type.Object({}),
    exposure: "hidden",
    sourceInfo: { source: "test", path: "/fixture", scope: "temporary", origin: "top-level" },
  },
];
