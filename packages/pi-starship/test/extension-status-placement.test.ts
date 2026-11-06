import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { activePalette, normalizeConfig, validateConfigDocument } from "../src/config.js";
import { formatVariables, parseFormat } from "../src/format/formatter.js";
import { parseStyle } from "../src/format/style.js";
import { renderStatusline, type StarshipRuntimeSnapshot } from "../src/modules/index.js";

type StatusEntry = readonly [string, string];

const STATUSES = [
  ["a", "alpha"],
  ["b", "beta"],
  ["c", "gamma"],
] as const;
const ESC = "\u001b";
const BEL = "\u0007";
const FILL = `\${fill}`;

function reference(key: string): string {
  return `\${extension_status.${key}}`;
}

function fixture(statuses: readonly StatusEntry[] = []): StarshipRuntimeSnapshot {
  return {
    cwd: "/work",
    thinkingLevel: "off",
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usingSubscription: false,
    gitBranch: null,
    extensionStatuses: new Map(statuses),
    now: new Date(0),
  };
}

function statusConfig(format: string, settings: Record<string, unknown> = {}) {
  const { config, diagnostics } = normalizeConfig({
    format,
    extension_status: {
      format: "[$statuses]($style)",
      style: "none",
      separator: " / ",
      max_statuses: 100,
      icons: { fallback: "" },
      ...settings,
    },
  });
  assert.deepEqual(diagnostics, []);
  for (const [name, module] of Object.entries(config.modules)) {
    if (name !== "extension_status") module.disabled = true;
  }
  return config;
}

function assertStatusStyle(
  rendered: ReturnType<typeof renderStatusline>,
  text: string,
  style: string,
  palette: Record<string, string> = {},
): void {
  const chunk = rendered.chunks.find((item) => item.text.includes(text));
  assert.ok(chunk, `Missing status chunk ${JSON.stringify(text)}`);
  assert.deepEqual(chunk.style ?? {}, parseStyle(style, palette) ?? {});
}

test("root status references preserve the complete parsed raw suffix", () => {
  const keys = [
    "plain",
    "lsp.typescript",
    "namespace:server:worker",
    "third_party/key",
    "Case",
    "case",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "Starship",
    "extension_status.inner.key",
    "namespace:*",
    "namespace.*",
  ];
  const format = keys.map(reference).join("|");
  assert.deepEqual(
    [...formatVariables(parseFormat(format))],
    keys.map((key) => `extension_status.${key}`),
  );
  assert.deepEqual(normalizeConfig({ format }).diagnostics, []);
  assert.deepEqual(validateConfigDocument("/status.toml", `format = '${format}'`).diagnostics, []);

  const statuses = keys.map((key, index): StatusEntry => [key, `value${index}`]);
  const reversed = keys.toReversed().map(reference).join("|");
  assert.equal(
    stripVTControlCharacters(renderStatusline(statusConfig(reversed), fixture(statuses)).ansi),
    statuses
      .toReversed()
      .map(([, value]) => value)
      .join("|"),
  );
});

test("empty suffixes, unrelated variables, and child references in module formats report diagnostics", () => {
  const { diagnostics } = normalizeConfig({
    format: `${reference("")}$unrelated`,
    model: { format: reference("usage") },
    extension_status: { format: `${reference("usage")}$statuses` },
  });
  const expected = [
    ["format", "extension_status."],
    ["format", "unrelated"],
    ["model.format", "extension_status.usage"],
    ["extension_status.format", "extension_status.usage"],
  ];
  assert.equal(diagnostics.length, expected.length);
  for (const [path, variable] of expected) {
    assert.ok(
      diagnostics.some(
        (item) =>
          item.severity === "warning" &&
          item.path === path &&
          item.message.includes(`Unknown variable ${JSON.stringify(variable)}`),
      ),
      `${path}: ${variable}`,
    );
  }

  const moduleOnly = normalizeConfig({
    format: "$extension_status",
    extension_status: { format: `${reference("usage")}$statuses`, icons: { fallback: "" } },
  });
  assert.equal(moduleOnly.diagnostics.length, 1);
  assert.equal(
    stripVTControlCharacters(renderStatusline(moduleOnly.config, fixture([["usage", "active"]])).ansi),
    "active",
  );
});

test.each([
  reference("raw[bad]"),
  reference("raw(bad)"),
  reference("raw$bad"),
  reference("raw{bad"),
  "${extension_status.usage",
])("status references retain existing syntax diagnostics: %s", (format) => {
  const { diagnostics } = normalizeConfig({ format });
  assert.ok(diagnostics.some((item) => item.path === "format" && /Invalid format/u.test(item.message)));
});

test("valid absent status references have no diagnostics or inherited-property output", () => {
  for (const key of ["absent.key:slot/path", "__proto__", "constructor", "toString"]) {
    const format = `left(${reference(key)})right`;
    const loaded = validateConfigDocument("/status.toml", `format = '${format}'`);
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(stripVTControlCharacters(renderStatusline(loaded.config, fixture(STATUSES)).ansi), "leftright");
  }
});

test("aggregate-only layouts preserve default order, filtering, cap, icons, and style with or without $all", () => {
  for (const format of ["$extension_status", "$all", "$all$extension_status"]) {
    const { config, diagnostics } = normalizeConfig({ format, extension_status: { max_statuses: 2 } });
    assert.deepEqual(diagnostics, []);
    for (const [name, module] of Object.entries(config.modules)) {
      if (name !== "extension_status") module.disabled = true;
    }
    const rendered = renderStatusline(config, fixture([["starship", "self"], ["empty", " "], ...STATUSES]));
    assert.equal(stripVTControlCharacters(rendered.ansi), "🔌 alpha • 🔌 beta");
    assertStatusStyle(rendered, "alpha", "dimmed white");
  }
});

test.each([
  ["aggregate", "$extension_status", "alpha / beta / gamma"],
  ["one child", reference("b"), "beta"],
  ["several children", `${reference("c")}|${reference("a")}`, "gamma|alpha"],
  ["aggregate before child", `$extension_status|${reference("a")}`, "beta / gamma|alpha"],
  ["aggregate after child", `${reference("a")}|$extension_status`, "alpha|beta / gamma"],
  ["nested child before aggregate", `([${reference("a")}](blue)|)$extension_status`, "alpha|beta / gamma"],
  ["nested child after aggregate", `$extension_status(|[(${reference("a")})](blue))`, "beta / gamma|alpha"],
  ["several nested children", `$extension_status(|[${reference("b")} (${reference("a")})](blue))`, "gamma|beta alpha"],
  ["all before child", `$all|${reference("a")}`, "beta / gamma|alpha"],
  ["all after child", `${reference("a")}|$all`, "alpha|beta / gamma"],
  ["all plus explicit aggregate", `$all($extension_status)(|${reference("a")})`, "beta / gamma|alpha"],
  ["explicit aggregate after all", `${reference("a")}|$all|$extension_status`, "alpha||beta / gamma"],
  ["repeated child", `${reference("a")}|${reference("a")}|$extension_status`, "alpha|alpha|beta / gamma"],
  ["repeated aggregate", `$extension_status|$extension_status|${reference("a")}`, "beta / gamma|beta / gamma|alpha"],
  ["repeated all", `$all|$all|${reference("a")}`, "beta / gamma|beta / gamma|alpha"],
  [
    "all statuses placed individually",
    `${reference("a")}|${reference("b")}|${reference("c")}(\n$extension_status)`,
    "alpha|beta|gamma",
  ],
])("status placement matrix: %s", (_name, format, expected) => {
  const rendered = renderStatusline(statusConfig(format), fixture(STATUSES));
  assert.equal(stripVTControlCharacters(rendered.ansi), expected);
});

test("raw key separators, case, and literal wildcards do not imply root aliases or selectors", () => {
  const statuses = [
    ["lsp.typescript", "dot"],
    ["lsp:typescript", "colon"],
    ["Lsp.typescript", "upper"],
    ["lsp/typescript", "slash"],
    ["lsp:*", "literal-colon"],
    ["lsp.*", "literal-dot"],
  ] as const;
  const format = `${reference("lsp:typescript")}|${reference("lsp:*")}|${reference("lsp.*")}|$extension_status`;
  assert.equal(
    stripVTControlCharacters(renderStatusline(statusConfig(format), fixture(statuses)).ansi),
    "colon|literal-colon|literal-dot|dot / upper / slash",
  );
  for (const key of ["lsp", "LSP.typescript", "lsp:missing", "lsp/Missing"]) {
    assert.equal(renderStatusline(statusConfig(reference(key)), fixture(statuses)).ansi, "");
  }
  assert.equal(renderStatusline(statusConfig(reference("lsp:*")), fixture([["lsp:typescript", "active"]])).ansi, "");
  assert.equal(renderStatusline(statusConfig(reference("lsp.*")), fixture([["lsp.typescript", "active"]])).ansi, "");
});

test.each([
  ["$extension_status", 1, false, "alpha"],
  [reference("d"), 1, false, "delta"],
  [`($extension_status)(|${reference("a")})`, 1, false, "beta|alpha"],
  [`(${reference("a")})(|$extension_status)`, 2, false, "alpha|beta / gamma"],
  [`($extension_status)(|${reference("d")})(|${reference("b")})`, 1, false, "alpha|delta|beta"],
  [`(${reference("d")})(|$extension_status)`, 2, false, "delta|alpha / beta"],
  [`($all)(|${reference("d")})(|${reference("b")})`, 1, false, "alpha|delta|beta"],
  [`($extension_status)(|${reference("d")})`, 0, false, ""],
  [`($all)(|${reference("d")})`, 0, false, ""],
  [reference("d"), 0, false, ""],
  [`($extension_status)(|${reference("d")})`, 2, true, ""],
  [`($all)(|${reference("d")})`, 2, true, ""],
  [reference("d"), 2, true, ""],
] satisfies [string, number, boolean, string][])(
  "status selection precedes independent expansion caps: %s / %i / disabled=%s",
  (format, cap, disabled, expected) => {
    const config = statusConfig(format, { max_statuses: cap, disabled });
    assert.equal(
      stripVTControlCharacters(renderStatusline(config, fixture([...STATUSES, ["d", "delta"]])).ansi),
      expected,
    );
  },
);

test.each([
  ["a", "S1:alpha!|S2:beta / gamma!"],
  ["d", "S1:delta!|S2:alpha / beta!"],
])("each expansion applies module format, symbol, and its post-selection count for %s", (key, expected) => {
  const config = statusConfig(`${reference(key)}|$extension_status`, {
    format: "[$symbol$count:$statuses!]($style)",
    symbol: "S",
    max_statuses: 2,
  });
  assert.equal(
    stripVTControlCharacters(renderStatusline(config, fixture([...STATUSES, ["d", "delta"]])).ansi),
    expected,
  );
});

test.each([
  ["missing", []],
  ["empty", [["chosen", ""]]],
  ["whitespace", [["chosen", " \t\n "]]],
  ["self", [["starship", "internal"]]],
  ["control-only", [["chosen", `${ESC}[31m${ESC}[0m${ESC}]52;c;secret${BEL}`]]],
  ["prefix-only", [["chosen", "chosen: "]]],
  ["suppressed emoji-only", [["chosen", "⚡"]]],
] satisfies [string, StatusEntry[]][])(
  "empty %s selections suppress static module decoration and conditional newlines",
  (_name, statuses) => {
    for (const moduleFormat of ["static", "$symbol", "$count", "[$symbol$count:$statuses!]($style)"]) {
      const config = statusConfig(
        `head(\n$extension_status)(\n${reference("chosen")})(\n${reference("starship")})tail`,
        {
          format: moduleFormat,
          symbol: "S",
          icons: { chosen: "", fallback: "" },
        },
      );
      assert.equal(renderStatusline(config, fixture(statuses)).ansi, "headtail");
    }
  },
);

test("filtered statuses do not consume either expansion allowance or leave separators", () => {
  const statuses = [
    ["empty", ""],
    ["space", " \t\n"],
    ["starship", "internal"],
    ["controls", `${ESC}[2J`],
    ["prefix", "prefix: "],
    ["emoji", "⚡"],
    ...STATUSES,
  ] as const;
  const config = statusConfig(
    `head(\n$extension_status)(\n${reference("empty")})(\n${reference("controls")})(\n${reference("c")})tail`,
    {
      format: "[$symbol$count:$statuses!]($style)",
      symbol: "S",
      max_statuses: 1,
      icons: { emoji: "", fallback: "" },
    },
  );
  assert.equal(
    stripVTControlCharacters(renderStatusline(config, fixture(statuses)).ansi),
    "head\nS1:alpha!\nS1:gamma!tail",
  );
});

const PRESENTATIONS: [string, string, Record<string, string>, Record<string, string>, string, string][] = [
  [
    "ns:deep:error",
    "⚡ running",
    { "ns:*": "N", "ns:deep:*": "D", "ns:deep:error": "E", fallback: "F" },
    { "ns:*": "green", "ns:deep:*": "bold blue", "ns:deep:error": "bold red", fallback: "yellow" },
    "E running",
    "bold red",
  ],
  [
    "ns:deep:worker",
    "⚡ running",
    { "ns:*": "N", "ns:deep:*": "D" },
    { "ns:*": "green", "ns:deep:*": "bold blue" },
    "D running",
    "bold blue",
  ],
  ["ns:task", "⚡ running", { "ns:*": "N" }, { "ns:*": "green" }, "N running", "green"],
  [
    "suppressed",
    "⚡ running",
    { suppressed: "", fallback: "F" },
    { suppressed: "none", fallback: "bold red" },
    "running",
    "none",
  ],
  ["leading", "⚡ running", { fallback: "F" }, { fallback: "bold yellow" }, "⚡ running", "bold yellow"],
  ["fallback", "running", { fallback: "F" }, { fallback: "bold purple" }, "F running", "bold purple"],
  ["default", "running", {}, {}, "🔌 running", "dimmed white"],
  ["unmapped", "running", { fallback: "" }, { other: "red" }, "running", "dimmed white"],
  ["toString", "running", { fallback: "F" }, { fallback: "yellow" }, "F running", "yellow"],
  ["constructor", "running", {}, { other: "red" }, "🔌 running", "dimmed white"],
  [
    "__proto__",
    "running",
    Object.fromEntries([["__proto__", "P"]]),
    Object.fromEntries([["__proto__", "cyan"]]),
    "P running",
    "cyan",
  ],
];

for (const [key, value, icons, styles, expected, style] of PRESENTATIONS) {
  test(`aggregate and child retain icon/style precedence for ${key}`, () => {
    const snapshot = fixture([[key, value]]);
    const aggregate = renderStatusline(
      statusConfig("$extension_status", { style: "dimmed white", icons, styles }),
      snapshot,
    );
    const child = renderStatusline(statusConfig(reference(key), { style: "dimmed white", icons, styles }), snapshot);
    assert.equal(stripVTControlCharacters(child.ansi), expected);
    assert.equal(child.ansi, aggregate.ansi);
    assertStatusStyle(child, expected, style);
  });
}

test("individual none and mapped styles preserve module styling for separators, counts, symbols, and unmapped neighbors", () => {
  const config = statusConfig(`${reference("a")}|$extension_status`, {
    format: "[$symbol$count:$statuses]($style)",
    symbol: "S",
    style: "dimmed white",
    styles: { a: "none", b: "bold red" },
  });
  const rendered = renderStatusline(config, fixture(STATUSES));
  assert.equal(stripVTControlCharacters(rendered.ansi), "S1:alpha|S2:beta / gamma");
  assertStatusStyle(rendered, "alpha", "none");
  assertStatusStyle(rendered, "beta", "bold red");
  for (const text of ["gamma", " / ", "S", "1", "2", ":"]) {
    assertStatusStyle(rendered, text, "dimmed white");
  }
});

test("quoted dotted icon/style keys use the active palette without adding dot wildcards or colon aliases", () => {
  const loaded = validateConfigDocument(
    "/status.toml",
    `
format = '${reference("lsp.typescript")}|${reference("lsp.other")}|${reference("lsp:typescript")}|$extension_status'
palette = 'demo'
[palettes.demo]
accent = '#123456'
[extension_status]
style = 'dimmed white'
[extension_status.icons]
"lsp.typescript" = 'TS'
"lsp.*" = 'NO-DOT-WILDCARD'
"lsp:*" = 'COLON'
fallback = 'F'
[extension_status.styles]
"lsp.typescript" = 'bold accent'
"lsp.*" = 'red'
"lsp:*" = 'green'
`,
  );
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.config.extensionStatus.icons["lsp.typescript"], "TS");
  assert.equal(loaded.config.extensionStatus.styles["lsp.typescript"], "bold accent");
  const rendered = renderStatusline(
    loaded.config,
    fixture([
      ["lsp.typescript", "alpha"],
      ["lsp.other", "beta"],
      ["lsp:typescript", "gamma"],
      ["lsp", "delta"],
    ]),
  );
  assert.equal(stripVTControlCharacters(rendered.ansi), "TS alpha|F beta|COLON gamma|F delta");
  assertStatusStyle(rendered, "TS alpha", "bold accent", activePalette(loaded.config));
  assertStatusStyle(rendered, "F beta", "dimmed white");
  assertStatusStyle(rendered, "COLON gamma", "green");
  assertStatusStyle(rendered, "F delta", "dimmed white");
});

test("raw key identity survives display sanitization and neither config nor snapshot is mutated", () => {
  const key = `raw${BEL}.key`;
  const attack = `${ESC}]52;c;secret${BEL}${ESC}[2J`;
  const config = statusConfig(`${reference(key)}|$extension_status`, {
    format: "[$symbol$count:$statuses]($style)",
    symbol: `${attack}S`,
    separator: `${attack} / `,
    icons: { [key]: `${attack}I`, "raw.key": "CLEAN" },
    styles: { [key]: "bold red", "raw.key": "green" },
  });
  const snapshot = fixture([
    [key, `${attack}${ESC}[31mready, 界 (local)${ESC}[0m`],
    ["raw.key", "other"],
    ["third", `${attack}busy`],
  ]);
  const before = structuredClone({ config, snapshot });
  const rendered = renderStatusline(config, snapshot, 80);
  assert.equal(stripVTControlCharacters(rendered.ansi), "S1:I ✓ 界|S2:CLEAN other / 🔌 busy");
  assertStatusStyle(rendered, "I ✓ 界", "bold red");
  assertStatusStyle(rendered, "CLEAN other", "green");
  assert.doesNotMatch(rendered.ansi, /secret|52;c|2J/u);
  for (const chunk of [...rendered.chunks, ...rendered.modules.extension_status]) {
    assert.ok(
      [...chunk.text].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 0x20 && (code < 0x7f || code > 0x9f);
      }),
    );
  }
  assert.deepEqual({ config, snapshot }, before);
});

test("raw keys outside the reference grammar remain available to the aggregate", () => {
  const keys = ["", "raw[key]", "raw(key)", "raw$key", "raw\\key", "raw{key", "raw}key"];
  const statuses = keys.map((key, index): StatusEntry => [key, `value${index}`]);
  const format = `${reference("chosen")}|$extension_status`;
  const rendered = renderStatusline(statusConfig(format), fixture([...statuses, ["chosen", "selected"]]));
  assert.equal(stripVTControlCharacters(rendered.ansi), `selected|${statuses.map(([, value]) => value).join(" / ")}`);
});

test("selected Unicode statuses participate in fill allocation without negative padding or leaked markers", () => {
  const config = statusConfig(`${reference("left")}${FILL}${reference("right")}`);
  config.modules.fill.disabled = false;
  config.modules.fill.symbol = "·";
  const snapshot = fixture([
    ["left", "界"],
    ["unselected", "long unrelated content"],
    ["right", "👩‍💻"],
  ]);
  const fixedWidth = visibleWidth("界👩‍💻 ");
  for (const width of [0, 1, 2, 3, 4, 5, 12]) {
    const rendered = renderStatusline(config, snapshot, width);
    assert.equal(stripVTControlCharacters(rendered.ansi), `界${"·".repeat(Math.max(0, width - fixedWidth))}👩‍💻 `);
    assert.equal(visibleWidth(rendered.ansi), Math.max(fixedWidth, width));
    assert.doesNotMatch(rendered.ansi, /unrelated|fill|marker/u);
    assert.ok(rendered.chunks.every((chunk) => typeof chunk.text === "string"));
  }

  const empty = statusConfig(`(${reference("absent")})${FILL}`);
  empty.modules.fill.disabled = false;
  assert.equal(renderStatusline(empty, snapshot, 0).ansi, "");
  assert.equal(visibleWidth(renderStatusline(empty, snapshot, 3).ansi), 3);
});
