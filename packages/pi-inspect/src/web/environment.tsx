import { Badge, Card, Heading, Text } from "@radix-ui/themes";
import type { Snapshot } from "../model.js";
import { Data } from "./components.js";
import { ToolExplorer } from "./tool-explorer.js";

export const resources = [
  { value: "tools", label: "Tools" },
  { value: "mcp", label: "MCP Servers" },
  { value: "skills", label: "Skills" },
] as const;
export type ResourceTab = (typeof resources)[number]["value"];

export function ResourcePanel({
  snapshot,
  resource: { value, label },
  active,
}: {
  snapshot?: Snapshot;
  resource: (typeof resources)[number];
  active: boolean;
}) {
  return (
    <>
      <div className="environment-heading">
        <Heading size="4">{label}</Heading>
        <Text as="p" size="2" color="gray">
          Current resource information · not historical request evidence.
        </Text>
        {!snapshot && <p role="status">Resource inventory unavailable until a snapshot loads.</p>}
        {snapshot?.incomplete && <p role="status">Snapshot incomplete; resource catalogs may be partial.</p>}
      </div>
      <section
        id={`resource-panel-${value}`}
        aria-label={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Read-only resource panels need keyboard focus for scrolling.
        tabIndex={0}
        className="resource-panel"
      >
        {value === "tools" && (
          <ToolExplorer key={snapshot?.generation ?? "loading"} tools={snapshot?.tools ?? []} active={active} />
        )}
        {value === "mcp" && (
          <>
            <p>Extension registrations only; the complete configured server catalog is unavailable.</p>
            <p>
              Connection/authentication status and authoritative server-to-tool associations are unavailable. A
              registration is not a connection.
            </p>
            {snapshot && (!snapshot.mcp || snapshot.mcp.unavailable) && (
              <p role="status">MCP registration API unavailable.</p>
            )}
            {snapshot?.mcp && !snapshot.mcp.unavailable && !snapshot.mcp.servers.length && (
              <p>No extension registrations reported. This does not mean no MCP servers exist.</p>
            )}
            {snapshot?.mcp?.truncated && <p role="status">MCP registration catalog truncated to 256 servers.</p>}
            {snapshot?.mcp?.servers.map((server, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Bounded display names can collide; position distinguishes catalog records.
              <Card key={`${index}-${server.name}`} className="inventory-card">
                <Heading size="2">{server.name}</Heading>
                <Badge highContrast color="gray">
                  extension registration
                </Badge>
                <p>
                  Connection status: unavailable. Tools: ownership unavailable; inspect the Tools tab for namespace
                  metadata.
                </p>
                {server.truncated && <p>Server name truncated.</p>}
              </Card>
            ))}
          </>
        )}
        {value === "skills" && (
          <>
            <p>
              Catalog captured when the inspector started; not continuously refreshed. Paths are source evidence, not
              verified file availability.
            </p>
            <p>
              Skill content unavailable: file contents are not captured or read. Advertised or read does not prove model
              compliance.
            </p>
            {snapshot && <p>Inspector capture started: {new Date(snapshot.captureStartedAt).toISOString()}</p>}
            {snapshot && !snapshot.skills.length && <p>No skills in the startup catalog.</p>}
            {snapshot?.skills.map((skill, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Bounded paths can collide; position distinguishes catalog records.
              <Card key={`${index}-${skill.path}`} className="inventory-card">
                <Heading size="2">{skill.name}</Heading>
                <Badge highContrast color="gray">
                  startup catalog
                </Badge>
                <p className="inventory-description">{skill.description}</p>
                <Data
                  label={`Path · ${skill.name}`}
                  data={{ value: skill.path, truncated: Boolean(skill.pathTruncated) }}
                  defaultOpen={false}
                />
                {skill.metadataTruncated && <p>Skill metadata truncated.</p>}
              </Card>
            ))}
          </>
        )}
      </section>
    </>
  );
}
