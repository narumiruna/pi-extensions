import { Checkbox, Select, TextField } from "@radix-ui/themes";
import { useId } from "react";
import type { Filters } from "./format.js";

/** Session-local, inline filters leave the result list visible at every viewport width. */
export function SessionFilters({ filters, change }: { filters: Filters; change(filters: Filters): void }) {
  const id = useId();
  return (
    <section className="panel session-filters" aria-label="Session filters">
      <div className="common-filters">
        <TextField.Root
          aria-label="Search session"
          placeholder="Search entries or content…"
          value={filters.query}
          onChange={(event) => change({ ...filters, query: event.target.value })}
        />
        <div className="filter-pills">
          {["All", "Model", "Tool", "Custom"].map((group) => (
            <button
              type="button"
              key={group}
              aria-pressed={
                group === "All" ? !filters.groups.length : filters.groups.length === 1 && filters.groups[0] === group
              }
              onClick={() => change({ ...filters, kind: "all", groups: group === "All" ? [] : [group] })}
            >
              {group}
            </button>
          ))}
        </div>
      </div>
      <details className="filter-panel">
        <summary>Advanced filters</summary>
        <div className="advanced-filters">
          <label className="filter-check" htmlFor={`${id}-errors`}>
            <span>Errors only</span>
            <Checkbox
              id={`${id}-errors`}
              checked={filters.errorsOnly}
              onCheckedChange={(checked) => change({ ...filters, errorsOnly: checked === true })}
            />
          </label>
          <label className="filter-check" htmlFor={`${id}-slow`}>
            <span>Slow tool calls (&gt; 10s)</span>
            <Checkbox
              id={`${id}-slow`}
              checked={filters.slowOnly}
              onCheckedChange={(checked) => change({ ...filters, slowOnly: checked === true })}
            />
          </label>
          {["Tool", "Model", "Custom"].map((group) => (
            <label className="filter-check" key={group} htmlFor={`${id}-${group}`}>
              <span>{group} events</span>
              <Checkbox
                id={`${id}-${group}`}
                checked={filters.groups.includes(group)}
                onCheckedChange={() =>
                  change({
                    ...filters,
                    groups: filters.groups.includes(group)
                      ? filters.groups.filter((item) => item !== group)
                      : [...filters.groups, group],
                  })
                }
              />
            </label>
          ))}
          <label className="filter-check" htmlFor={`${id}-kind`}>
            <span>Entry type</span>
            <Select.Root value={filters.kind} onValueChange={(kind) => change({ ...filters, kind })}>
              <Select.Trigger id={`${id}-kind`} aria-label="Filter entry type" />
              <Select.Content>
                {[
                  "all",
                  "user",
                  "assistant",
                  "toolResult",
                  "system",
                  "custom",
                  "custom_message",
                  "compaction",
                  "branch_summary",
                  "model_change",
                  "thinking_level_change",
                  "context_edit",
                  "usage",
                  "label",
                  "session_info",
                ].map((kind) => (
                  <Select.Item key={kind} value={kind}>
                    {kind}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </label>
        </div>
      </details>
    </section>
  );
}
