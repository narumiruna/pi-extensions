import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { TokenType, tokenize } from "@csstools/css-tokenizer";

const baselinePath = "scripts/source-comments-baseline.txt";
const sourcePath = /^packages\/[^/]+\/src\/.+\.(?:[cm]?[jt]s|[jt]sx|css)$/u;
const newline = /\r\n|[\r\n\u2028\u2029]/gu;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function scanFile(file, source) {
  const ranges = file.endsWith(".css")
    ? tokenize({ css: source })
        .filter(([kind]) => kind === TokenType.Comment)
        .map(([, , start, end]) => ({ start, end: end + 1 }))
    : parse(source, {
        attachComment: false,
        sourceType: /\.c[jt]s$/u.test(file) ? "commonjs" : "unambiguous",
        plugins: [
          ...(/\.(?:[cm]?ts|tsx)$/u.test(file) ? [["typescript", { dts: /\.d\.[cm]?ts$/u.test(file) }]] : []),
          ...(/\.[jt]sx$/u.test(file) ? ["jsx"] : []),
          "decorators-legacy",
        ],
      }).comments;
  if (ranges.length === 0) return { comments: [], commentOnlyLines: 0 };

  const lineStarts = [0, ...Array.from(source.matchAll(newline), (match) => match.index + match[0].length)];
  const lineIndex = (offset) => lineStarts.findLastIndex((start) => start <= offset);
  const touched = new Set();
  const retained = [];
  let cursor = 0;
  const comments = ranges.map(({ start, end }) => {
    const raw = source.slice(start, end);
    retained.push(source.slice(cursor, start), raw.replace(/[^\r\n\u2028\u2029]/gu, " "));
    cursor = end;
    const line = lineIndex(start);
    const lastLine = lineIndex(end - 1);
    for (let i = line; i <= lastLine; i++) touched.add(i);
    const hash = createHash("sha256").update(raw.replaceAll("\r\n", "\n")).digest("hex");
    return { file, line: line + 1, column: start - lineStarts[line] + 1, raw, key: `${JSON.stringify(file)}\t${hash}` };
  });
  retained.push(source.slice(cursor));
  const lines = retained.join("").split(newline);
  return { comments, commentOnlyLines: [...touched].filter((line) => lines[line].trim() === "").length };
}

export function inventory(prefix = "packages") {
  const paths = git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "packages/")
    .split("\0")
    .filter((path) => sourcePath.test(path) && (path === prefix || path.startsWith(`${prefix}/`)));
  const comments = [];
  let commentOnlyLines = 0;
  for (const file of [...new Set(paths)].sort()) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    try {
      const scanned = scanFile(file, source);
      comments.push(...scanned.comments);
      commentOnlyLines += scanned.commentOnlyLines;
    } catch (error) {
      throw new Error(`Cannot scan ${file}: ${error.message}`, { cause: error });
    }
  }
  return { comments, commentOnlyLines };
}

function counts(keys) {
  const result = new Map();
  for (const key of keys) result.set(key, (result.get(key) ?? 0) + 1);
  return result;
}

function excess(items, allowedKeys, keyFor) {
  const remaining = counts(allowedKeys);
  return items.filter((item) => {
    const key = keyFor(item);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

function baselineKeys(source) {
  return source.split(/\r?\n/u).filter(Boolean);
}

function location({ file, line, column }) {
  return `${file}:${line}:${column}`;
}

function run(args) {
  const [mode, path] = args;
  if (mode === "--help" && args.length === 1) {
    console.log("Usage: node scripts/check-source-comments.mjs [--list [packages/<package>/src[/path]] | --prune]");
    return 0;
  }
  if (mode === "--list" && args.length <= 2) {
    const prefix = path?.replace(/\/$/u, "");
    const { comments, commentOnlyLines } = inventory(prefix);
    for (const comment of comments) console.log(`${location(comment)} ${JSON.stringify(comment.raw)}`);
    console.error(`${comments.length} comments on ${commentOnlyLines} removable lines (excluding lines with code).`);
    return 0;
  }
  const prune = mode === "--prune" && args.length === 1;
  if (args.length !== 0 && !prune) {
    throw new Error("Invalid arguments. See node scripts/check-source-comments.mjs --help.");
  }

  const { comments, commentOnlyLines } = inventory();
  const baseline = readFileSync(baselinePath, "utf8").replaceAll("\r\n", "\n");
  const allowed = baselineKeys(baseline);
  if (git("ls-tree", "--name-only", "HEAD", "--", baselinePath)) {
    const baseKeys = baselineKeys(git("show", `HEAD:${baselinePath}`));
    const added = excess(allowed, baseKeys, (key) => key);
    if (added.length > 0) {
      throw new Error(`The comment baseline cannot grow. Remove these entries:\n${added.join("\n")}`);
    }
  }

  const added = excess(comments, allowed, (comment) => comment.key);
  if (added.length > 0) {
    throw new Error(`New source comments are not allowed:\n${added.map(location).join("\n")}`);
  }

  const current = comments.map(({ key }) => key).sort();
  const updated = current.length ? `${current.join("\n")}\n` : "";
  if (updated !== baseline) {
    if (!prune) throw new Error("Comment baseline is out of date. Run node scripts/check-source-comments.mjs --prune.");
    writeFileSync(baselinePath, updated);
  }
  console.log(`Source comments: ${comments.length} grandfathered, ${commentOnlyLines} comment-only lines.`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
