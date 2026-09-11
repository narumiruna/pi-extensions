import { createRequire } from "node:module";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { HLJSApi } from "highlight.js";

const require = createRequire(import.meta.url);
let highlighter: HLJSApi | undefined;

export type SyntaxTheme = Pick<Theme, "fg" | "bold"> & Partial<Pick<Theme, "italic" | "underline">>;

type Formatter = (text: string) => string;

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  sql: "sql",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmake: "cmake",
  lua: "lua",
  perl: "perl",
  r: "r",
  scala: "scala",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  vim: "vim",
  graphql: "graphql",
  proto: "protobuf",
  tf: "hcl",
  hcl: "hcl",
};

const SCOPE_COLORS: Readonly<Record<string, ThemeColor>> = {
  keyword: "syntaxKeyword",
  built_in: "syntaxType",
  literal: "syntaxNumber",
  number: "syntaxNumber",
  regexp: "syntaxString",
  string: "syntaxString",
  comment: "syntaxComment",
  doctag: "syntaxComment",
  meta: "muted",
  function: "syntaxFunction",
  title: "syntaxFunction",
  class: "syntaxType",
  type: "syntaxType",
  tag: "syntaxPunctuation",
  name: "syntaxKeyword",
  attr: "syntaxVariable",
  variable: "syntaxVariable",
  params: "syntaxVariable",
  operator: "syntaxOperator",
  punctuation: "syntaxPunctuation",
  addition: "toolDiffAdded",
  deletion: "toolDiffRemoved",
};

export function getLanguageFromPath(filePath: string): string | undefined {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return extension ? LANGUAGE_BY_EXTENSION[extension] : undefined;
}

export function highlightCode(code: string, language: string | undefined, theme: SyntaxTheme): string {
  if (!language) return plainCode(code, theme);
  const hljs = loadHighlighter();
  if (!hljs.getLanguage(language)) return plainCode(code, theme);
  try {
    const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    return theme.fg("mdCodeBlock", renderHighlightedHtml(html, syntaxFormatters(theme)));
  } catch {
    return theme.fg("mdCodeBlock", code);
  }
}

function loadHighlighter(): HLJSApi {
  if (highlighter) return highlighter;
  const loaded = require("highlight.js") as unknown;
  const candidate = highlightApi(loaded) ?? highlightApi(moduleDefault(loaded));
  if (!candidate) throw new TypeError("highlight.js did not expose its expected API");
  highlighter = candidate;
  return candidate;
}

function highlightApi(value: unknown): HLJSApi | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<HLJSApi>;
  return typeof candidate.getLanguage === "function" && typeof candidate.highlight === "function"
    ? (candidate as HLJSApi)
    : undefined;
}

function moduleDefault(value: unknown): unknown {
  return value && typeof value === "object" && "default" in value ? value.default : undefined;
}

function plainCode(code: string, theme: SyntaxTheme): string {
  return theme.fg("mdCodeBlock", theme.fg("mdCodeBlock", code));
}

function syntaxFormatters(theme: SyntaxTheme): Readonly<Record<string, Formatter>> {
  const formatters: Record<string, Formatter> = {};
  for (const [scope, color] of Object.entries(SCOPE_COLORS)) {
    formatters[scope] = (text) => theme.fg(color, text);
  }
  formatters.emphasis = (text) => theme.italic?.(text) ?? text;
  formatters.strong = (text) => theme.bold(text);
  formatters.link = (text) => theme.underline?.(text) ?? text;
  return formatters;
}

function renderHighlightedHtml(html: string, formatters: Readonly<Record<string, Formatter>>): string {
  let output = "";
  let textBuffer = "";
  const scopes: Array<string | undefined> = [];
  const flush = () => {
    if (!textBuffer) return;
    output += activeFormatter(scopes, formatters)?.(textBuffer) ?? textBuffer;
    textBuffer = "";
  };

  for (let index = 0; index < html.length; ) {
    if (html.startsWith("<span", index)) {
      const tagEnd = html.indexOf(">", index + 5);
      if (tagEnd >= 0) {
        flush();
        scopes.push(scopeFromTag(html.slice(index, tagEnd + 1)));
        index = tagEnd + 1;
        continue;
      }
    }
    if (html.startsWith("</span>", index)) {
      flush();
      scopes.pop();
      index += "</span>".length;
      continue;
    }
    if (html[index] === "&") {
      const entityEnd = html.indexOf(";", index + 1);
      if (entityEnd >= 0) {
        const decoded = decodeEntity(html.slice(index + 1, entityEnd));
        if (decoded !== undefined) {
          textBuffer += decoded;
          index = entityEnd + 1;
          continue;
        }
      }
    }
    textBuffer += html[index];
    index += 1;
  }
  flush();
  return output;
}

function scopeFromTag(tag: string): string | undefined {
  const classValue = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(tag)?.slice(1).find(Boolean);
  return classValue
    ?.split(/\s+/u)
    .find((className) => className.startsWith("hljs-"))
    ?.slice("hljs-".length);
}

function activeFormatter(
  scopes: readonly (string | undefined)[],
  formatters: Readonly<Record<string, Formatter>>,
): Formatter | undefined {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index];
    if (!scope) continue;
    const exact = formatters[scope];
    if (exact) return exact;
    const prefix = scope.split(/[.-]/u)[0];
    if (prefix && formatters[prefix]) return formatters[prefix];
  }
  return undefined;
}

function decodeEntity(entity: string): string | undefined {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  if (named[entity] !== undefined) return named[entity];
  const radix = entity.startsWith("#x") || entity.startsWith("#X") ? 16 : 10;
  const digits = entity.startsWith("#x") || entity.startsWith("#X") ? entity.slice(2) : entity.slice(1);
  if (!entity.startsWith("#") || !digits) return undefined;
  const codePoint = Number.parseInt(digits, radix);
  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return undefined;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return undefined;
  }
}
