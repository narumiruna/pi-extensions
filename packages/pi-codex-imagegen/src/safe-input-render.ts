import { CURSOR_MARKER, renderFakeCursor } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit";

type NativeInput = { focused: boolean; render(width: number): string[] };
const SAMPLE = "__imagegen_cursor_cell__";
const [FAKE_START, FAKE_END] = renderFakeCursor(SAMPLE).split(SAMPLE);

/** Find only the marker added by native focus, not marker-shaped draft text. */
function cursorInsertion(focused: string, unfocused: string): number | undefined {
  if (!FAKE_START || focused.length !== unfocused.length + CURSOR_MARKER.length) return undefined;
  let prefix = 0;
  while (prefix < unfocused.length && focused[prefix] === unfocused[prefix]) prefix++;
  let suffix = 0;
  while (suffix < unfocused.length && focused[focused.length - 1 - suffix] === unfocused[unfocused.length - 1 - suffix])
    suffix++;
  // Prefix/suffix bounds prove removal restores the unfocused rendering. Keep
  // this linear even when a pasted draft contains many marker-shaped strings.
  const first = unfocused.length - suffix;
  // Adjacent draft markers can also satisfy the insertion proof. The native
  // marker is the one immediately before its fake cursor, not an earlier copy.
  const index = focused.indexOf(CURSOR_MARKER + FAKE_START, first);
  return index >= first && index <= prefix ? index : undefined;
}

/** Sanitize all native content, then reconstruct only proven native cursor metadata. */
export function renderSafeInput(input: NativeInput, width: number): string[] {
  const focused = input.focused;
  let withoutCursor: string[];
  let withCursor: string[];
  try {
    // Public focus changes only cursor metadata in Pi Input/Editor. Rendering both
    // states proves provenance without reading private cursor/draft fields or
    // changing editing, undo, paste, mouse geometry, or submission state.
    input.focused = false;
    withoutCursor = input.render(width);
    input.focused = true;
    withCursor = input.render(width);
  } finally {
    input.focused = focused;
  }
  return withCursor.map((line, row) => {
    const original = withoutCursor[row];
    const cursor = original === undefined ? undefined : cursorInsertion(line, original);
    if (cursor === undefined || !FAKE_START || !FAKE_END) return sanitizeTerminalText(line);
    const afterMarker = line.slice(cursor + CURSOR_MARKER.length);
    const end = afterMarker.indexOf(FAKE_END, FAKE_START.length);
    // Fail closed if a future native renderer changes its cursor protocol.
    if (!afterMarker.startsWith(FAKE_START) || end < 0) return sanitizeTerminalText(line);
    const before = sanitizeTerminalText(line.slice(0, cursor));
    const cell = sanitizeTerminalText(afterMarker.slice(FAKE_START.length, end));
    const after = sanitizeTerminalText(afterMarker.slice(end + FAKE_END.length));
    return `${before}${focused ? CURSOR_MARKER : ""}${renderFakeCursor(cell)}${after}`;
  });
}
