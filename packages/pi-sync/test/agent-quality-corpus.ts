import type { AgentCandidate, AgentUnit } from "../src/sync/agent-candidate.js";

/** Synthetic oracles only: these choices are not measured model responses. */
export interface AgentQualityFixture {
  id: string;
  path: string;
  base: string;
  /** null means a missing file; an empty string means an existing empty file. */
  local: string | null;
  remote: string | null;
  units: Omit<AgentUnit, "id" | "path">[];
  /** Exact code-owned spans before, between, and after text units. */
  codeOwned?: string[];
  results: AgentCandidate["results"];
  expected:
    | { kind: "accepted"; content: string }
    | { kind: "refused"; ids: string[]; reason: string }
    | { kind: "unsupported" };
}

const settingsVersions = {
  path: "settings.json",
  base: '\uFEFF{\r\n  "defaultProvider" : "base-provider",\r\n  "defaultModel": "base-model",\r\n  "enableAnalytics": false,\r\n  "trackingId": "base-id",\r\n  "unknown" : { "n": 1.00e0 },\r\n  "theme": "base"\r\n}\r\n',
  local:
    '\uFEFF{\r\n  "defaultProvider" : "local-provider",\r\n  "defaultModel": "local-model",\r\n  "enableAnalytics": true,\r\n  "trackingId": "local-id",\r\n  "unknown" : { "n": 1.00e0 },\r\n  "theme": "local"\r\n}\r\n',
  remote:
    '{"defaultProvider":"remote-provider","defaultModel":"remote-model","enableAnalytics":false,"trackingId":"remote-id","unknown":{"n":1},"theme":"base"}',
  units: [
    {
      kind: "settings" as const,
      base: '{"defaultProvider":"base-provider","defaultModel":"base-model"}',
      local: '{"defaultProvider":"local-provider","defaultModel":"local-model"}',
      remote: '{"defaultProvider":"remote-provider","defaultModel":"remote-model"}',
    },
    {
      kind: "settings" as const,
      base: '{"enableAnalytics":false,"trackingId":"base-id"}',
      local: '{"enableAnalytics":true,"trackingId":"local-id"}',
      remote: '{"enableAnalytics":false,"trackingId":"remote-id"}',
    },
  ],
};

export const agentQualityCorpus: readonly AgentQualityFixture[] = [
  {
    id: "separate-overlapping-hunks",
    path: "AGENTS.md",
    base: "header  \nalpha: base\nbetween\t\nbeta: base\nfooter\n",
    local: "header  \nalpha: local\nbetween\t\nbeta: local\nfooter\nlocal tail  \n",
    remote: "remote intro\t\nheader  \nalpha: remote\nbetween\t\nbeta: remote\nfooter\n",
    units: [
      { kind: "text", base: "alpha: base\n", local: "alpha: local\n", remote: "alpha: remote\n" },
      { kind: "text", base: "beta: base\n", local: "beta: local\n", remote: "beta: remote\n" },
    ],
    codeOwned: ["remote intro\t\nheader  \n", "between\t\n", "footer\nlocal tail  \n"],
    results: [
      { id: "0", content: "alpha: local + remote\n" },
      { id: "1", content: "beta: local + remote\n" },
    ],
    expected: {
      kind: "accepted",
      content:
        "remote intro\t\nheader  \nalpha: local + remote\nbetween\t\nbeta: local + remote\nfooter\nlocal tail  \n",
    },
  },
  {
    id: "bridged-overlapping-hunks",
    path: "prompts/bridge.md",
    base: "start\none\ntwo\nthree\nfinish\n",
    local: "start\none local\ntwo\nthree local\nfinish\n",
    remote: "start\nremote block\nfinish\n",
    units: [
      {
        kind: "text",
        base: "one\ntwo\nthree\n",
        local: "one local\ntwo\nthree local\n",
        remote: "remote block\n",
      },
    ],
    codeOwned: ["start\n", "finish\n"],
    results: [{ id: "0", content: "one local\nremote block\nthree local\n" }],
    expected: { kind: "accepted", content: "start\none local\nremote block\nthree local\nfinish\n" },
  },
  {
    id: "same-point-insertions",
    path: "AGENTS.md",
    base: "start\nend\n",
    local: "start\nlocal insert\nend\n",
    remote: "start\nremote insert\nend\n",
    units: [{ kind: "text", base: "", local: "local insert\n", remote: "remote insert\n" }],
    codeOwned: ["start\n", "end\n"],
    results: [{ id: "0", content: "local insert\nremote insert\n" }],
    expected: { kind: "accepted", content: "start\nlocal insert\nremote insert\nend\n" },
  },
  {
    id: "insertion-at-deletion-start",
    path: "AGENTS.md",
    base: "head\nremove\nkeep\ntail\n",
    local: "head\nkeep\ntail\n",
    remote: "head\ninsert\nremove\nkeep\ntail\n",
    units: [{ kind: "text", base: "remove\n", local: "", remote: "insert\nremove\n" }],
    codeOwned: ["head\n", "keep\ntail\n"],
    results: [{ id: "0", content: "insert\n" }],
    expected: { kind: "accepted", content: "head\ninsert\nkeep\ntail\n" },
  },
  {
    id: "insertion-at-deletion-end",
    path: "AGENTS.md",
    base: "head\nremove\nkeep\ntail\n",
    local: "head\nkeep\ntail\n",
    remote: "head\nremove\ninsert\nkeep\ntail\n",
    units: [{ kind: "text", base: "remove\n", local: "", remote: "remove\ninsert\n" }],
    codeOwned: ["head\n", "keep\ntail\n"],
    results: [{ id: "0", content: "insert\n" }],
    expected: { kind: "accepted", content: "head\ninsert\nkeep\ntail\n" },
  },
  {
    id: "delete-versus-modify-hunk",
    path: "AGENTS.md",
    base: "head\nremove\nfoot\n",
    local: "head\nfoot\n",
    remote: "head\nchanged\nfoot\n",
    units: [{ kind: "text", base: "remove\n", local: "", remote: "changed\n" }],
    codeOwned: ["head\n", "foot\n"],
    results: [{ id: "0", refuse: true }],
    expected: {
      kind: "refused",
      ids: ["0"],
      reason: "Deletion and modification have no agreed intent; an empty text replacement is also forbidden.",
    },
  },
  {
    id: "repeated-lines",
    path: "skills/repeated/SKILL.md",
    base: "heading\nsame\nslot: base\nsame\nfooter\n",
    local: "heading\nsame\nslot: local\nsame\nfooter\n",
    remote: "heading\nsame\nslot: remote\nsame\nfooter\n",
    units: [{ kind: "text", base: "slot: base\n", local: "slot: local\n", remote: "slot: remote\n" }],
    codeOwned: ["heading\nsame\n", "same\nfooter\n"],
    results: [{ id: "0", content: "slot: local + remote\n" }],
    expected: { kind: "accepted", content: "heading\nsame\nslot: local + remote\nsame\nfooter\n" },
  },
  {
    id: "crlf-unicode-and-unterminated-footer",
    path: "AGENTS.md",
    base: "title café  \r\nrule: base\r\nfooter\t",
    local: "title café  \r\nrule: local\r\nfooter\t",
    remote: "title café  \r\nrule: remote\r\nfooter\t",
    units: [{ kind: "text", base: "rule: base\r\n", local: "rule: local\r\n", remote: "rule: remote\r\n" }],
    codeOwned: ["title café  \r\n", "footer\t"],
    results: [{ id: "0", content: "rule: local + remote\r\n" }],
    expected: { kind: "accepted", content: "title café  \r\nrule: local + remote\r\nfooter\t" },
  },
  {
    id: "unterminated-owned-last-line",
    path: "AGENTS.md",
    base: "header\nrule: base",
    local: "header\nrule: local",
    remote: "header\nrule: remote",
    units: [{ kind: "text", base: "rule: base", local: "rule: local", remote: "rule: remote" }],
    codeOwned: ["header\n", ""],
    results: [{ id: "0", content: "rule: local + remote" }],
    expected: { kind: "accepted", content: "header\nrule: local + remote" },
  },
  ...(["smaller", "larger"] as const).map(
    (choice): AgentQualityFixture => ({
      id: `hidden-context-${choice}`,
      path: "AGENTS.md",
      base: `Policy: choose the ${choice} proposed timeout.\nTimeout: 10\nfooter\n`,
      local: `Policy: choose the ${choice} proposed timeout.\nTimeout: 20\nfooter\n`,
      remote: `Policy: choose the ${choice} proposed timeout.\nTimeout: 30\nfooter\n`,
      units: [{ kind: "text", base: "Timeout: 10\n", local: "Timeout: 20\n", remote: "Timeout: 30\n" }],
      codeOwned: [`Policy: choose the ${choice} proposed timeout.\n`, "footer\n"],
      results: [{ id: "0", refuse: true }],
      expected: {
        kind: "refused",
        ids: ["0"],
        reason: "The hunk omits the policy needed to select a timeout; the fixture must refuse without more context.",
      },
    }),
  ),
  {
    id: "coupled-settings-remote-model-local-analytics",
    ...settingsVersions,
    results: [
      { id: "0", source: "remote" },
      { id: "1", source: "local" },
    ],
    expected: {
      kind: "accepted",
      content:
        '\uFEFF{\r\n  "defaultProvider" : "remote-provider",\r\n  "defaultModel": "remote-model",\r\n  "enableAnalytics": true,\r\n  "trackingId": "local-id",\r\n  "unknown" : { "n": 1.00e0 },\r\n  "theme": "local"\r\n}\r\n',
    },
  },
  {
    id: "coupled-settings-local-model-remote-analytics",
    ...settingsVersions,
    results: [
      { id: "0", source: "local" },
      { id: "1", source: "remote" },
    ],
    expected: {
      kind: "accepted",
      content:
        '\uFEFF{\r\n  "defaultProvider" : "local-provider",\r\n  "defaultModel": "local-model",\r\n  "enableAnalytics": false,\r\n  "trackingId": "remote-id",\r\n  "unknown" : { "n": 1.00e0 },\r\n  "theme": "local"\r\n}\r\n',
    },
  },
  {
    id: "existing-empty-file-versus-modification",
    path: "AGENTS.md",
    base: "base\n",
    local: "",
    remote: "remote\n",
    units: [{ kind: "text", base: "base\n", local: "", remote: "remote\n" }],
    codeOwned: ["", ""],
    results: [{ id: "0", refuse: true }],
    expected: {
      kind: "refused",
      ids: ["0"],
      reason: "The local file exists with zero bytes; this is an eligible but ambiguous text unit, not a missing file.",
    },
  },
  ...(["local", "remote"] as const).map(
    (deletedSide): AgentQualityFixture => ({
      id: `${deletedSide}-file-deletion-versus-modification`,
      path: "AGENTS.md",
      base: "base\n",
      local: deletedSide === "local" ? null : "local\n",
      remote: deletedSide === "remote" ? null : "remote\n",
      units: [],
      results: [],
      expected: { kind: "unsupported" },
    }),
  ),
];
