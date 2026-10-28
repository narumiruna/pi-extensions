import {
  ChatBubbleIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardCopyIcon,
  CubeIcon,
  ExclamationTriangleIcon,
  FileTextIcon,
  GearIcon,
  LightningBoltIcon,
  PersonIcon,
  StackIcon,
} from "@radix-ui/react-icons";
import { Badge, Button, Flex } from "@radix-ui/themes";
import { useEffect, useRef, useState } from "react";
import type { Capture, Json } from "../model.js";
import { group, output } from "./format.js";
import { JsonTree } from "./json-tree.js";

export function Glyph({ kind }: { kind: string }) {
  const Icon =
    kind === "toolResult"
      ? StackIcon
      : kind === "toolCall"
        ? GearIcon
        : kind === "assistant"
          ? ChatBubbleIcon
          : kind === "user"
            ? PersonIcon
            : kind === "thinking_level_change"
              ? GearIcon
              : group(kind) === "Model"
                ? CubeIcon
                : group(kind) === "Tool"
                  ? LightningBoltIcon
                  : kind === "system"
                    ? FileTextIcon
                    : CubeIcon;
  return (
    <span
      className={`event-glyph glyph-${group(kind).toLowerCase()} ${kind === "thinking_level_change" ? "glyph-thinking" : ""}`}
    >
      <Icon />
    </span>
  );
}
export function Status({ value = "recorded" }: { value?: string }) {
  const label =
    value === "ok" || value === "success"
      ? "Success"
      : value === "error"
        ? "Error"
        : value === "running"
          ? "Running"
          : value === "cancelled"
            ? "Cancelled"
            : value === "unfinished"
              ? "Unfinished"
              : "Recorded";
  return (
    <span className={`status status-${value}`}>
      {label === "Success" ? (
        <CheckIcon />
      ) : label === "Error" ? (
        <ExclamationTriangleIcon />
      ) : (
        <span className="status-dot" />
      )}
      {label}
    </span>
  );
}
function images(value: Json, found: { data: string; mimeType: string }[] = []): typeof found {
  if (!value || typeof value !== "object" || found.length >= 4) return found;
  if (
    !Array.isArray(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string" &&
    /^(image\/(png|jpeg|gif|webp))$/.test(value.mimeType) &&
    value.data.length <= 16384 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value.data)
  ) {
    if (!found.some((image) => image.data === value.data && image.mimeType === value.mimeType))
      found.push({ data: value.data, mimeType: value.mimeType });
  } else for (const child of Object.values(value)) images(child, found);
  return found;
}
export function Copy({ value }: { value: string }) {
  const mounted = useRef(false);
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function copy() {
    setPending(true);
    try {
      await navigator.clipboard.writeText(value);
      if (mounted.current) setFeedback("Copied");
    } catch {
      if (mounted.current) setFeedback("Copy failed");
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  return (
    <Button
      size="1"
      variant="ghost"
      className="copy-button"
      disabled={pending}
      onClick={() => void copy()}
      aria-label="Copy display data"
    >
      <ClipboardCopyIcon />
      {feedback || "Copy"}
    </Button>
  );
}
function colored(line: string, budget: { remaining: number }) {
  if (line.length > 2000 || budget.remaining <= 0) return line;
  const fragments = [];
  let cursor = 0;
  for (const match of line.matchAll(/("(?:[^"\\]|\\.)*"|\b(?:true|false|null|\d+(?:\.\d+)?)\b)/g)) {
    if (--budget.remaining < 0) return line;
    if (match.index > cursor) fragments.push(line.slice(cursor, match.index));
    const part = match[0];
    fragments.push(
      <span
        key={match.index}
        className={
          part.startsWith('"')
            ? /^\s*:/.test(line.slice(match.index + part.length))
              ? "json-key"
              : "json-string"
            : "json-number"
        }
      >
        {part}
      </span>,
    );
    cursor = match.index + part.length;
  }
  fragments.push(line.slice(cursor));
  return fragments;
}
export interface DataState {
  open: boolean;
  format: "tree" | "text";
}
export function Data({
  data,
  label,
  defaultOpen = true,
  scope = label,
  state,
  changeState,
}: {
  data?: Capture;
  label: string;
  defaultOpen?: boolean;
  scope?: string;
  state?: DataState;
  changeState?(state: DataState): void;
}) {
  const [localState, setLocalState] = useState<DataState>({ open: defaultOpen, format: "tree" });
  const { open, format } = state ?? localState;
  const change = changeState ?? setLocalState;
  const value = data ? output(data.value) : "unavailable";
  const lines = value.split("\n");
  const budget = { remaining: 512 };
  let sourceOffset = 0;
  const structured = data?.value !== null && typeof data?.value === "object";
  return (
    <section className="data">
      <div className="data-toolbar">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={open}
          onClick={() => change({ open: !open, format })}
        >
          <ChevronRightIcon className={open ? "chevron-open" : ""} />
          <span>{label}</span>
        </button>
        <Flex align="center" gap="2">
          {data?.truncated && <Badge color="amber">truncated</Badge>}
          {data && <Copy key={value} value={value} />}
        </Flex>
      </div>
      {open && (
        <div>
          {structured && (
            <div className="data-mode">
              {(["tree", "text"] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  aria-pressed={format === mode}
                  onClick={() => change({ open, format: mode })}
                >
                  {mode === "tree" ? "Objects" : "JSON text"}
                </button>
              ))}
              <span>Redacted display copy</span>
            </div>
          )}
          {structured && format === "tree" && data ? (
            <JsonTree value={data.value} scope={scope} />
          ) : (
            <pre className="code-preview">
              {lines.slice(0, 1000).map((line, index) => {
                const start = sourceOffset;
                sourceOffset += line.length + 1;
                return (
                  <span className="code-line" key={`line-${start}`}>
                    <span className="line-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <code>{colored(line, budget)}</code>
                  </span>
                );
              })}
              {lines.length > 1000 && (
                <span className="preview-limit">
                  Preview limited to 1,000 lines; Copy includes the bounded display value.
                </span>
              )}
            </pre>
          )}
          {data &&
            images(data.value).map((image) => (
              <img
                key={`${image.mimeType}-${image.data}`}
                className="preview-image"
                src={`data:${image.mimeType};base64,${image.data}`}
                alt="Captured raster tool output"
              />
            ))}
        </div>
      )}
    </section>
  );
}
export function Metadata({ rows }: { rows: [string, string | undefined][] }) {
  return (
    <dl className="metadata">
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd title={value}>{value || "unavailable"}</dd>
        </div>
      ))}
    </dl>
  );
}
