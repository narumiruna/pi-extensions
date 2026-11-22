export const MAX_MCP_SERVERS = 32;
export const MAX_MCP_SERVER_NAME_LENGTH = 128;

export function isMcpServerSelection(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_MCP_SERVERS &&
    value.every(
      (name) =>
        typeof name === "string" &&
        name.length > 0 &&
        name.length <= MAX_MCP_SERVER_NAME_LENGTH &&
        !/[^A-Za-z0-9_-]/u.test(name),
    )
  );
}

export function resolveMcpServers(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isMcpServerSelection(value)) {
    throw new Error(
      `Subagent mcpServers must contain at most ${MAX_MCP_SERVERS} exact server names (1–${MAX_MCP_SERVER_NAME_LENGTH} letters, digits, underscores, or hyphens each).`,
    );
  }
  return [...new Set(value)];
}
