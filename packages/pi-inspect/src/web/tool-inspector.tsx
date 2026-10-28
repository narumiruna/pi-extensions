import { Fragment, useMemo, useState } from "react";
import type { Capture, Json } from "../model.js";
import { Copy, Data } from "./components.js";
import { output } from "./format.js";
import { parseSchema, type SchemaNode, type ToolDoc, toolDocuments } from "./tool-schema.js";

function DocumentationText({ value }: { value: string }) {
  const parts = useMemo(() => {
    const parts: { id: string; text: string; code: boolean }[] = [];
    let offset = 0;
    for (const match of value.matchAll(/^```[^\n]*\n([\s\S]*?)^```[ \t]*(?:\n|$)/gm)) {
      parts.push({ id: `text-${offset}`, text: value.slice(offset, match.index), code: false });
      parts.push({ id: `code-${match.index}`, text: match[1] ?? "", code: true });
      offset = match.index + match[0].length;
    }
    parts.push({ id: `text-${offset}`, text: value.slice(offset), code: false });
    return parts;
  }, [value]);
  return parts.map((part) =>
    part.code ? (
      <pre key={part.id}>{part.text}</pre>
    ) : (
      <div key={part.id} className="tool-prose">
        {part.text}
      </div>
    ),
  );
}

function SchemaRows({
  node,
  depth = 0,
  expansion,
}: {
  node: SchemaNode;
  depth?: number;
  expansion?: Map<string, boolean>;
}) {
  const [open, setOpen] = useState(() => expansion?.get(node.id) ?? false);
  return (
    <Fragment>
      <tr>
        <th scope="row" style={{ paddingLeft: `${8 + Math.min(depth, 8) * 12}px` }}>
          {node.children.length ? (
            <button
              type="button"
              className="schema-toggle"
              aria-expanded={open}
              onClick={() => {
                expansion?.set(node.id, !open);
                setOpen(!open);
              }}
            >
              <span aria-hidden="true">{open ? "▾" : "▸"}</span> {node.name}
            </button>
          ) : (
            node.name
          )}
        </th>
        <td>
          <code className="schema-type">{node.type}</code>
        </td>
        <td
          title={
            node.required === "unknown"
              ? "Other schema constraints or documentation limits may require this field; inspect the schema branches or Raw JSON."
              : undefined
          }
        >
          {node.required === undefined ? "—" : node.required === "unknown" ? "Unknown" : node.required ? "Yes" : "No"}
        </td>
        <td>
          {node.description && <div className="tool-prose">{node.description}</div>}
          {node.annotations.map(([key, value]) => (
            <div className="schema-annotation" key={key}>
              <span>{key}: </span>
              <code>{JSON.stringify(value)}</code>
            </div>
          ))}
          {node.limited && (
            <p role="status">Documentation limit reached; inspect Raw JSON for the complete captured schema.</p>
          )}
        </td>
      </tr>
      {open &&
        node.children.map((child) => (
          <SchemaRows key={child.id} node={child} depth={depth + 1} expansion={expansion} />
        ))}
    </Fragment>
  );
}
export function ParameterSchema({ value, expansion }: { value: Json; expansion?: Map<string, boolean> }) {
  const root = useMemo(() => parseSchema(value), [value]);
  return (
    <div className="schema-scroll">
      <table className="parameter-schema">
        <caption>Input parameters</caption>
        <thead>
          <tr>
            <th scope="col">Parameter</th>
            <th scope="col">Type</th>
            <th scope="col">Required</th>
            <th scope="col">Description / constraints</th>
          </tr>
        </thead>
        <tbody>
          <SchemaRows node={{ ...root, children: [] }} expansion={expansion} />
          {root.children.map((node) => (
            <SchemaRows key={node.id} node={node} expansion={expansion} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
function ToolDetails({ tool, scope, truncated }: { tool: ToolDoc; scope: string; truncated: boolean }) {
  const [mode, setMode] = useState("documentation");
  return (
    <section className="tool-documentation" aria-label="Selected tool documentation">
      <div className="tool-heading">
        <h3>{tool.name}</h3>
        <Copy key={JSON.stringify(tool.raw)} value={JSON.stringify(tool.raw, null, 2)} />
      </div>
      <div className="view-switch">
        {["documentation", "raw"].map((value) => (
          <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>
            {value === "raw" ? "Raw JSON" : "Documentation"}
          </button>
        ))}
      </div>
      {mode === "raw" ? (
        <Data
          label="Original captured tool declaration"
          data={{ value: tool.raw, truncated }}
          scope={`${scope}-tool-${tool.id}`}
        />
      ) : (
        <>
          {tool.description ? (
            <DocumentationText value={tool.description} />
          ) : (
            <p className="tool-muted">No description supplied.</p>
          )}
          {tool.parameters === undefined ? (
            <p className="tool-muted">Input schema unspecified.</p>
          ) : (
            <ParameterSchema value={tool.parameters} />
          )}
          {tool.returns !== undefined && (
            <section>
              <h4>Returns</h4>
              <p className="tool-muted">Declared or documented return information; not an inferred output schema.</p>
              <pre>{output(tool.returns)}</pre>
            </section>
          )}
          {tool.codemode && (
            <section>
              <h4>Codemode</h4>
              <DocumentationText value={tool.codemode} />
            </section>
          )}
          {tool.examples.length > 0 && (
            <section>
              <h4>Declared examples</h4>
              {tool.examples.map((example) => (
                <div key={example.id}>
                  <Copy key={JSON.stringify(example.value)} value={JSON.stringify(example.value, null, 2)} />
                  <pre>{JSON.stringify(example.value, null, 2)}</pre>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}
export function ToolInspector({ data, scope }: { data?: Capture; scope: string }) {
  const tools = useMemo(() => toolDocuments(data?.value), [data?.value]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number>();
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return tools.filter((tool) =>
      `${tool.name}\n${tool.description}\n${tool.codemode}`.toLocaleLowerCase().includes(search),
    );
  }, [tools, query]);
  const tool = filtered.find((tool) => tool.id === selected) ?? filtered[0];
  if (!data || !Array.isArray(data.value))
    return <Data label="Historical declared tools · preview branch" data={data} scope={scope} />;
  return (
    <section className="tool-inspector" aria-label="Historical declared tools">
      <p className="tool-muted">Historical declared tools · preview branch · {tools.length} tools</p>
      {data.truncated && (
        <p role="status">
          Captured declarations are truncated. Documentation and Raw JSON show only the available display copy.
        </p>
      )}
      <div className="tool-browser">
        <nav className="tool-navigation" aria-label="Declared tools">
          <input
            type="search"
            aria-label="Search tools"
            placeholder="Search tools…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="tool-list">
            {filtered.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={tool?.id === item.id}
                onClick={() => setSelected(item.id)}
              >
                <strong>{item.name}</strong>
                <span>{item.description.split("\n")[0] || "No description supplied"}</span>
              </button>
            ))}
          </div>
          {!filtered.length && (
            <p className="tool-muted">{tools.length ? "No matching tools." : "No declared tools."}</p>
          )}
        </nav>
        {tool && <ToolDetails key={`${scope}:${tool.id}`} tool={tool} scope={scope} truncated={data.truncated} />}
      </div>
    </section>
  );
}
