import { execFileSync, spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryUrl = "https://github.com/narumiruna/pi-extensions";
// Keep sources outside .cache, which Zensical removes during --clean.
const outputDirectory = ".zensical-docs";

function sitePath(source) {
  return source === "docs/index.md" ? "index.md" : source;
}

// Only Markdown destinations are changed, never fenced examples or inline code.
export function rewriteLinks(markdown, source, files, repositoryPaths) {
  const destination = (href) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(href)) return href;
    const [, pathname, suffix = ""] = href.match(/^([^?#]*)(.*)$/);
    const target = posix.normalize(posix.join(posix.dirname(source), decodeURI(pathname).replace(/\\([()])/g, "$1")));
    if (!repositoryPaths.has(target)) throw new Error(`${source}: missing link target ${href}`);
    if (files.has(target)) {
      return `${posix.relative(posix.dirname(sitePath(source)), sitePath(target))}${suffix}`;
    }
    const kind = repositoryPaths.get(target) === "directory" ? "tree" : "blob";
    const encoded = target.split("/").map(encodeURIComponent).join("/");
    return `${repositoryUrl}/${kind}/main/${encoded}${suffix}`;
  };

  let fence;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          line.slice(marker[0].length).trim() === ""
        )
          fence = undefined;
        return line;
      }
      if (marker) {
        fence = marker[1];
        return line;
      }
      const rewrite = (href) => (href.startsWith("<") ? `<${destination(href.slice(1, -1))}>` : destination(href));
      // Preserve reference labels, link titles, images, and query/fragment suffixes.
      const reference = line.match(/^(\s{0,3}\[(?!\^)[^\]]+\]:\s*)(<[^>]+>|\S+)(.*)$/);
      if (reference) return `${reference[1]}${rewrite(reference[2])}${reference[3]}`;
      const tokens = /(`+).*?\1|\]\(/g;
      let result = "";
      let copied = 0;
      for (let token = tokens.exec(line); token; token = tokens.exec(line)) {
        if (token[1]) continue;
        const start = token.index + 2;
        let end = start;
        if (line[start] === "<") {
          const closing = line.indexOf(">", start + 1);
          if (closing < 0) continue;
          end = closing + 1;
        } else {
          let depth = 0;
          for (; end < line.length; end++) {
            const char = line[end];
            if (char === "\\") end++;
            else if (char === "(") depth++;
            else if (char === ")") {
              if (depth === 0) break;
              depth--;
            } else if (/\s/.test(char)) break;
          }
          if (depth !== 0 || end === start) continue;
        }
        // A destination must be followed by a closing delimiter or a quoted title.
        const tail = line
          .slice(end)
          .match(/^(?:[ \t]+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?[ \t]*\)/);
        if (!tail) continue;
        result += line.slice(copied, start) + rewrite(line.slice(start, end));
        copied = end;
        tokens.lastIndex = end + tail[0].length;
      }
      return result + line.slice(copied);
    })
    .join("\n");
}

export async function prepareDocs(root = repositoryRoot) {
  // Honor Git ignores so local drafts and generated files cannot become site assets.
  const repositoryFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path && existsSync(resolve(root, path)))
    .sort();
  const paths = repositoryFiles.filter((path) => /^(?:docs\/|packages\/[^/]+\/docs\/)/.test(path));
  const files = new Set();
  const repositoryPaths = new Map();
  for (const path of paths) {
    let info;
    try {
      info = await lstat(resolve(root, path));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile()) throw new Error(`Documentation must be a regular file: ${path}`);
    files.add(path);
    repositoryPaths.set(path, "file");
  }

  // Resolve repository-only links without copying README, skills, tests, or source.
  for (const path of repositoryFiles) {
    if (!repositoryPaths.has(path)) repositoryPaths.set(path, "file");
    for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent))
      repositoryPaths.set(parent, "directory");
  }
  repositoryPaths.set(".", "directory");

  const prepared = new Map();
  for (const source of files) {
    const bytes = await readFile(resolve(root, source));
    prepared.set(
      sitePath(source),
      source.endsWith(".md") ? rewriteLinks(bytes.toString("utf8"), source, files, repositoryPaths) : bytes,
    );
  }
  const output = resolve(root, outputDirectory);
  await mkdir(output, { recursive: true });
  // Remove conflicts before publication so a file can replace a directory, or vice versa.
  for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) {
    const path = posix.relative(output, posix.join(entry.parentPath, entry.name));
    if (entry.isDirectory() ? prepared.has(path) : !prepared.has(path)) {
      await rm(resolve(output, path), { recursive: true, force: true });
    }
  }
  for (const [path, content] of prepared) {
    const target = resolve(output, path);
    let previous;
    try {
      previous = await readFile(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previous?.equals(Buffer.from(content))) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(`${target}.tmp`, content);
    await rename(`${target}.tmp`, target);
  }
  return prepared.size;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["build", "serve"].includes(command))
    throw new Error("Usage: node scripts/docs.mjs <build|serve> [zensical options]");
  console.log(`Prepared ${await prepareDocs()} documentation files.`);
  const sourceDirectories = [
    "docs",
    ...(await readdir(resolve(repositoryRoot, "packages"))).map((name) => `packages/${name}/docs`),
  ]
    .map((path) => resolve(repositoryRoot, path))
    .filter(existsSync);
  const watchers = [];
  let timer;
  let preparing = Promise.resolve();
  const stop = () => {
    for (const watcher of watchers) watcher.close();
    clearTimeout(timer);
  };
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      preparing = preparing
        .then(() => prepareDocs())
        .catch((error) => {
          console.error(error.message);
          process.exitCode = 1;
          child.kill("SIGTERM");
        });
    }, 100);
  };
  if (command === "serve") {
    try {
      for (const path of sourceDirectories) watchers.push(watch(path, { recursive: true }, changed));
    } catch (error) {
      stop();
      throw error;
    }
  }
  const child = spawn("uvx", ["zensical", command, ...(command === "build" ? ["--strict"] : []), ...args], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  const interrupt = (signal) => {
    stop();
    child.kill(signal);
  };
  const sigint = () => interrupt("SIGINT");
  const sigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  child.on("error", (error) => {
    console.error(error.message);
    stop();
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    stop();
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
    if (process.exitCode) return;
    process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : (code ?? 1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
