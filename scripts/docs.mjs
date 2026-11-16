import { execFileSync, spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteLinks, sitePath } from "./docs-markdown.mjs";

export { rewriteLinks };

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
// Keep sources outside .cache, which Zensical removes during --clean.
const outputDirectory = ".zensical-docs";

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

async function withDocsOwnership(root, run) {
  const path = resolve(root, ".zensical-docs.lock");
  let lock;
  try {
    lock = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      "Another documentation command owns .zensical-docs.lock. Stop it first; see docs/documentation.md for crash recovery.",
    );
  }
  try {
    await lock.writeFile(String(process.pid) + "\n");
    return await run();
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(path, { force: true });
    }
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["build", "serve"].includes(command))
    throw new Error("Usage: node scripts/docs.mjs <build|serve> [zensical options]");
  const watchers = [];
  let timer;
  let preparing = Promise.resolve();
  let child;
  let stopping = false;
  const stop = () => {
    stopping = true;
    for (const watcher of watchers) watcher.close();
    clearTimeout(timer);
  };
  const interrupt = (signal) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    stop();
    child?.kill(signal);
  };
  const sigint = () => interrupt("SIGINT");
  const sigterm = () => interrupt("SIGTERM");
  // Install cancellation before acquiring ownership or starting asynchronous work.
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  try {
    await withDocsOwnership(repositoryRoot, async () => {
      try {
        if (stopping) return;
        const count = await prepareDocs();
        if (stopping) return;
        console.log("Prepared " + count + " documentation files.");
        if (command === "serve") {
          const sourceDirectories = [
            "docs",
            ...(await readdir(resolve(repositoryRoot, "packages"))).map((name) => "packages/" + name + "/docs"),
          ]
            .map((path) => resolve(repositoryRoot, path))
            .filter(existsSync);
          if (stopping) return;
          const changed = () => {
            if (stopping) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
              preparing = preparing
                .then(() => (stopping ? undefined : prepareDocs()))
                .catch((error) => {
                  if (stopping) return;
                  console.error(error.message);
                  process.exitCode = 1;
                  stop();
                  child?.kill("SIGTERM");
                });
            }, 100);
          };
          for (const path of sourceDirectories) watchers.push(watch(path, { recursive: true }, changed));
        }
        child = spawn("uvx", ["zensical", command, ...(command === "build" ? ["--strict"] : []), ...args], {
          cwd: repositoryRoot,
          stdio: "inherit",
        });
        const { code, signal } = await new Promise((done) => {
          child.on("error", (error) => {
            console.error(error.message);
            process.exitCode = 1;
            stop();
          });
          child.once("close", (code, signal) => done({ code, signal }));
        });
        if (!process.exitCode) process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : (code ?? 1);
      } finally {
        stop();
        // Do not release ownership while an admitted refresh can still publish.
        await preparing;
      }
    });
  } finally {
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    if (!process.exitCode) process.exitCode = 1;
  });
}
