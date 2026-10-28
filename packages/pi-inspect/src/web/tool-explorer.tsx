import { Cross2Icon } from "@radix-ui/react-icons";
import { Badge, Heading, IconButton, Popover } from "@radix-ui/themes";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ToolView } from "../model.js";
import { Data, type DataState, Metadata } from "./components.js";
import { NavigationTabs } from "./navigation-tabs.js";
import { PaneDrawer, useNarrow } from "./panes.js";
import { boundedSearch, searchNeedle } from "./search.js";
import { ParameterSchema } from "./tool-inspector.js";
import {
  compactGroupLabel,
  type InventoryGrouping,
  type InventoryRow,
  inventoryGroups,
  inventoryRows,
  type ToolColumn,
  toolCell,
  toolColumns,
} from "./tool-inventory.js";
import "./tool-explorer.css";

const eligibility =
  "Eligibility through Pi's nested-tool API, used by codemode. Runner availability, permission and execution success are not verified. This is not observed usage.";
const detailTabs = [
  { value: "overview", label: "Overview" },
  { value: "parameters", label: "Parameters" },
  { value: "source", label: "Source" },
] as const;

type DetailTab = (typeof detailTabs)[number]["value"];
interface DetailReading {
  tab: DetailTab;
  schema: DataState;
  source: DataState;
}
function initialReading(): DetailReading {
  return { tab: "overview", schema: { open: false, format: "tree" }, source: { open: false, format: "tree" } };
}
function ToolDetails({
  tool,
  reading,
  change,
  scroll,
  parameterExpansion,
  scope,
}: {
  tool: ToolView;
  reading: DetailReading;
  change(reading: DetailReading): void;
  scroll: RefObject<number>;
  parameterExpansion: Map<string, boolean>;
  scope: string;
}) {
  const { tab } = reading;
  const content = useRef<HTMLDivElement>(null);
  const previousTab = useRef(tab);
  useLayoutEffect(() => {
    if (previousTab.current !== tab) scroll.current = 0;
    previousTab.current = tab;
    if (content.current) content.current.scrollTop = scroll.current;
  }, [scroll, tab]);
  return (
    <div
      className="tool-detail-content"
      ref={content}
      onScroll={(event) => {
        scroll.current = event.currentTarget.scrollTop;
      }}
    >
      <Heading size="3">{tool.name}</Heading>
      <div className="tool-badges">
        <Badge highContrast color="gray">
          {tool.exposure}
        </Badge>
        <Badge highContrast color={tool.callable ? "blue" : "gray"}>
          {tool.callable ? "Codemode eligible" : "Not eligible"}
        </Badge>
        <Badge highContrast color={tool.active ? "green" : "gray"}>
          {tool.active ? "Active" : "Inactive"}
        </Badge>
      </div>
      {tool.metadataTruncated && <p role="status">Tool metadata truncated.</p>}
      <NavigationTabs
        id="tool-detail"
        label="Tool detail sections"
        tabs={detailTabs}
        value={tab}
        change={(value) => {
          change({
            ...reading,
            tab: value as DetailTab,
            source: value === "source" ? { ...reading.source, open: true } : reading.source,
          });
        }}
      />
      <section key={tab} role="tabpanel" id={`tool-detail-panel-${tab}`} aria-labelledby={`tool-detail-tab-${tab}`}>
        {tab === "overview" && (
          <>
            <p className="inventory-description">{tool.description || "Description unavailable."}</p>
            <Metadata
              rows={[
                ["Exposure", tool.exposure],
                ["Codemode eligibility", tool.callable ? "Eligible" : "No"],
                ["Codemode runner", "Not verified"],
                ["Active", tool.active ? "Yes" : "No"],
                ["Source", tool.sourceGroup?.label ?? "Unknown source"],
                ["Namespace", tool.namespace],
              ]}
            />
            <p className="tool-note">{eligibility}</p>
          </>
        )}
        {tab === "parameters" && (
          <>
            {tool.schema.truncated && (
              <p role="status">Captured schema truncated; parameter documentation may be partial.</p>
            )}
            <ParameterSchema value={tool.schema.value} expansion={parameterExpansion} />
          </>
        )}
        {(tab === "overview" || tab === "source") && (
          <Data
            key="source"
            scope={`${scope}:source`}
            label={`Source · ${tool.name}`}
            data={tool.source}
            state={reading.source}
            changeState={(source) => change({ ...reading, source })}
          />
        )}
        {tab !== "source" && (
          <Data
            key="schema"
            scope={`${scope}:schema`}
            label={`Schema · ${tool.name}`}
            data={tool.schema}
            state={reading.schema}
            changeState={(schema) => change({ ...reading, schema })}
          />
        )}
      </section>
    </div>
  );
}

function SourceNavigation({
  rows,
  grouping,
  selected,
  change,
}: {
  rows: InventoryRow[];
  grouping: InventoryGrouping;
  selected: string;
  change(id: string): void;
}) {
  const groups = inventoryGroups(rows);
  const categories =
    grouping === "exposure"
      ? [{ label: "Exposure", kinds: ["unknown"] }]
      : [
          { label: "Built-in", kinds: ["builtin"] },
          { label: "Namespaces", kinds: ["namespace"] },
          { label: "Extensions", kinds: ["extension"] },
          { label: "Packages", kinds: ["package"] },
          { label: "Unknown", kinds: ["unknown"] },
        ];
  return (
    <nav className="tool-sources" aria-label="Tool sources">
      <Heading size="2">{grouping === "exposure" ? "Exposure groups" : "Sources"}</Heading>
      <button type="button" className="tool-source" aria-pressed={selected === "all"} onClick={() => change("all")}>
        <span>All tools</span>
        <span className="tool-count">{rows.length}</span>
      </button>
      {categories.map(({ label, kinds }) => {
        const entries = groups.filter(({ group }) => kinds.includes(group.kind));
        if (!entries.length) return null;
        return (
          <details key={label} open className="tool-source-category">
            <summary>
              {label}
              <span className="tool-count">{entries.reduce((sum, entry) => sum + entry.count, 0)}</span>
            </summary>
            {entries.map(({ group, count }) => (
              <button
                type="button"
                className="tool-source"
                key={group.id}
                title={`${group.label}${group.truncated ? " · truncated" : ""}`}
                aria-pressed={selected === group.id}
                onClick={() => change(group.id)}
              >
                <span>
                  {compactGroupLabel(group)}
                  {group.truncated && " · truncated"}
                </span>
                <span className="tool-count">{count}</span>
              </button>
            ))}
          </details>
        );
      })}
      <p className="tool-note">Namespace metadata does not verify MCP ownership or connection health.</p>
    </nav>
  );
}

export function ToolExplorer({ tools, active }: { tools: ToolView[]; active: boolean }) {
  const narrow = useNarrow();
  const [grouping, setGrouping] = useState<InventoryGrouping>("namespace");
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");
  const [exposure, setExposure] = useState("all");
  const [columns, setColumns] = useState<ReadonlySet<ToolColumn>>(() => new Set(["exposure", "codemode", "active"]));
  const [selected, setSelected] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [reading, setReading] = useState<DetailReading>(initialReading);
  const detailScroll = useRef(0);
  const parameterExpansion = useRef(new Map<string, boolean>());
  const activeOwner = useRef(active);
  activeOwner.current = active;
  const pendingDetailFocus = useRef(false);
  const reopenTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const sourceTrigger = useRef<HTMLButtonElement>(null);
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const rows = useMemo(() => inventoryRows(tools, grouping), [tools, grouping]);
  const groups = useMemo(() => inventoryGroups(rows), [rows]);
  const selectedSource = groups.find(({ group }) => group.id === source)?.group;
  // A disappearing source returns to All; a disappearing tool never selects a replacement by position.
  const effectiveSource = selectedSource ? source : "all";
  const current = rows.find((row) => row.id === selected);
  useEffect(() => {
    if (source !== "all" && !selectedSource) setSource("all");
    if (selected && !current) {
      setSelected(undefined);
      setDetailsOpen(false);
      if (active) searchInput.current?.focus({ preventScroll: true });
    }
    if (exposure !== "all" && !tools.some((tool) => tool.exposure === exposure)) setExposure("all");
  }, [source, selectedSource, selected, current, active, exposure, tools]);
  useEffect(() => {
    if (!narrow) setSourcesOpen(false);
    if (!active) {
      setSourcesOpen(false);
      if (narrow) setDetailsOpen(false);
      setColumnsOpen(false);
    }
  }, [active, narrow]);
  const needle = searchNeedle(query);
  const visible = rows.filter(
    ({ tool, group }) =>
      (effectiveSource === "all" || group.id === effectiveSource) &&
      (exposure === "all" || tool.exposure === exposure) &&
      [tool.name, tool.description, tool.namespace, tool.sourceGroup?.label].some((value) =>
        value?.toLowerCase().includes(needle),
      ),
  );
  function selectSource(id: string) {
    setSource(id);
    setSourcesOpen(false);
  }
  const restoreDetailFocus = useCallback(() => {
    if (!activeOwner.current) return;
    for (const target of [detailTrigger.current, reopenTrigger.current, searchInput.current]) {
      if (target?.isConnected && !target.disabled && target.getClientRects().length) {
        target.focus({ preventScroll: true });
        break;
      }
    }
  }, []);
  function closeDetails() {
    pendingDetailFocus.current = true;
    setDetailsOpen(false);
  }
  useEffect(() => {
    if (!detailsOpen && pendingDetailFocus.current) {
      pendingDetailFocus.current = false;
      restoreDetailFocus();
    }
  }, [detailsOpen, restoreDetailFocus]);
  const sources = <SourceNavigation rows={rows} grouping={grouping} selected={effectiveSource} change={selectSource} />;
  const details = current && (
    <ToolDetails
      key={current.id}
      scope={current.id}
      tool={current.tool}
      reading={reading}
      change={setReading}
      scroll={detailScroll}
      parameterExpansion={parameterExpansion.current}
    />
  );
  return (
    <div className={`tool-explorer ${detailsOpen && current && !narrow ? "with-details" : ""}`}>
      <p className="tool-inventory-note">
        Current active ≠ provider-visible. Codemode shows nested-call eligibility, not observed usage.
      </p>
      <div className="tool-explorer-layout">
        {!narrow && <aside className="tool-source-pane">{sources}</aside>}
        <section className="tool-table-pane" aria-label="Tool inventory">
          <div className="tool-toolbar">
            <div className="tool-breadcrumb">
              <strong title={selectedSource?.label}>
                {selectedSource ? compactGroupLabel(selectedSource) : "All tools"}
              </strong>
              <span>
                {visible.length} / {tools.length} tools
              </span>
            </div>
            <div className="tool-toolbar-controls">
              {narrow && (
                <button type="button" ref={sourceTrigger} onClick={() => setSourcesOpen(true)}>
                  Sources
                </button>
              )}
              <input
                ref={searchInput}
                type="search"
                aria-label="Search tools"
                placeholder="Search tools…"
                value={query}
                onChange={(event) => setQuery(boundedSearch(event.target.value))}
              />
              <label>
                Group by
                <select
                  aria-label="Group tools by"
                  value={grouping}
                  onChange={(event) => {
                    setGrouping(event.target.value as InventoryGrouping);
                    setSource("all");
                  }}
                >
                  <option value="namespace">Namespace</option>
                  <option value="source">Source</option>
                  <option value="exposure">Exposure</option>
                </select>
              </label>
              <label>
                Exposure
                <select
                  aria-label="Filter tool exposure"
                  value={exposure}
                  onChange={(event) => setExposure(event.target.value)}
                >
                  <option value="all">All</option>
                  {[...new Set(tools.map((tool) => tool.exposure))].sort().map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <Popover.Root open={active && columnsOpen} onOpenChange={setColumnsOpen}>
                <Popover.Trigger>
                  <button type="button" className="tool-columns-trigger">
                    Columns
                  </button>
                </Popover.Trigger>
                <Popover.Content
                  className="tool-resource-popover tool-columns-menu"
                  aria-label="Visible tool columns"
                  align="end"
                  collisionPadding={8}
                  onCloseAutoFocus={(event) => {
                    if (!activeOwner.current) event.preventDefault();
                  }}
                >
                  <fieldset>
                    <legend>Visible columns</legend>
                    <label>
                      <input type="checkbox" checked disabled />
                      Name (required)
                    </label>
                    {toolColumns.map(({ id, label }) => (
                      <label key={id}>
                        <input
                          type="checkbox"
                          checked={columns.has(id)}
                          onChange={() =>
                            setColumns((old) => {
                              const next = new Set(old);
                              if (next.has(id)) next.delete(id);
                              else next.add(id);
                              return next;
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </fieldset>
                </Popover.Content>
              </Popover.Root>
              {current && !detailsOpen && (
                <button
                  type="button"
                  ref={reopenTrigger}
                  onClick={(event) => {
                    detailTrigger.current = event.currentTarget;
                    setDetailsOpen(true);
                  }}
                >
                  Show tool details
                </button>
              )}
            </div>
          </div>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded table region needs keyboard focus for native horizontal and vertical scrolling. */}
          <section className="tool-table-scroll" tabIndex={0} aria-label="Scrollable tools table">
            <table className="tool-inventory-table">
              <caption className="sr-only">Current tools. Select a name to inspect its metadata.</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  {toolColumns
                    .filter(({ id }) => columns.has(id))
                    .map(({ id, label }) => (
                      <th scope="col" key={id} title={id === "codemode" ? eligibility : undefined}>
                        {label}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(({ id, tool }) => (
                  <tr key={id} data-selected={selected === id || undefined}>
                    <th scope="row">
                      <button
                        type="button"
                        aria-label={`Inspect ${tool.name}`}
                        aria-pressed={selected === id}
                        onClick={(event) => {
                          detailTrigger.current = event.currentTarget;
                          if (selected !== id) {
                            setReading(initialReading());
                            detailScroll.current = 0;
                            parameterExpansion.current.clear();
                          }
                          setSelected(id);
                          setDetailsOpen(true);
                        }}
                        title={tool.name}
                      >
                        {tool.name}
                      </button>
                    </th>
                    {toolColumns
                      .filter(({ id }) => columns.has(id))
                      .map(({ id: column }) => (
                        <td
                          key={column}
                          title={
                            column === "codemode"
                              ? eligibility
                              : column === "source"
                                ? tool.sourceGroup?.label
                                : toolCell(tool, column)
                          }
                        >
                          <span className={`tool-cell-${column}`}>{toolCell(tool, column)}</span>
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!tools.length ? (
              <p className="tool-empty">No tools in this snapshot.</p>
            ) : (
              !visible.length && (
                <p className="tool-empty" role="status">
                  No tools match these filters.
                </p>
              )
            )}
          </section>
          <p className="tool-note tool-table-note">
            Codemode runner availability is not verified. Namespace/source metadata does not prove MCP server ownership.
          </p>
        </section>
        {!narrow && detailsOpen && current && (
          <aside className="tool-detail-pane" aria-label="Tool details">
            <div className="tool-panel-heading">
              <Heading size="2">Tool details</Heading>
              <IconButton variant="ghost" aria-label="Close tool details" onClick={closeDetails}>
                <Cross2Icon />
              </IconButton>
            </div>
            {details}
          </aside>
        )}
      </div>
      {narrow && (
        <>
          <PaneDrawer
            name="Tool sources"
            className="tool-resource-drawer"
            open={active && sourcesOpen}
            change={setSourcesOpen}
            side="left"
            trigger={sourceTrigger}
          >
            <div className="tool-explorer tool-drawer-body">{sources}</div>
          </PaneDrawer>
          <PaneDrawer
            name="Tool details"
            className="tool-resource-drawer"
            open={active && detailsOpen && Boolean(current)}
            change={setDetailsOpen}
            side="right"
            trigger={detailTrigger}
            restoreFocus={restoreDetailFocus}
          >
            <div className="tool-explorer tool-drawer-body">{details}</div>
          </PaneDrawer>
        </>
      )}
    </div>
  );
}
