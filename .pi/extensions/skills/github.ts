import { createHash } from "node:crypto";
import { inspectBundleMetadata, inspectMetadata } from "./metadata.ts";
import type { BundleFile, GitEntry, RemoteSkill, RepositorySnapshot, SkillBundle } from "./types.ts";

/** Fixed safety limits, not user settings. Each public operation owns one deadline. */
export const GITHUB_LIMITS = Object.freeze({
  timeoutMs: 60_000,
  candidates: 128,
  entries: 20_000,
  filesPerBundle: 512,
  files: 2_048,
  fileBytes: 4 * 1024 * 1024,
  metadataBytes: 256 * 1024,
  totalBytes: 32 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  parallelism: 4,
});

export interface GitHubDependencies {
  fetch?: typeof fetch;
}

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?\/[a-zA-Z0-9_.-]{1,100}$/;

export function parseRepository(input: string): string {
  // Match the original spelling, not URL's normalized path (which removes ../).
  const repository = input.startsWith("https://github.com/") ? input.slice("https://github.com/".length) : input;
  if (
    !REPOSITORY.test(repository) ||
    repository.split("/")[1] === "." ||
    repository.split("/")[1] === ".." ||
    repository.endsWith(".git")
  ) {
    throw new Error("Use owner/repo or an exact https://github.com/owner/repo URL");
  }
  return repository;
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls and nonportable path bytes.
    !/[\\:\x00-\x1f\x7f-\x9f]/.test(path) &&
    path
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git" &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

function regular(entry: GitEntry): boolean {
  return entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}

function supported(entry: GitEntry): boolean {
  return regular(entry) || (entry.type === "tree" && entry.mode === "040000");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid GitHub API response");
  }
  return value as Record<string, unknown>;
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error("Invalid GitHub commit or object SHA");
  return value;
}

function validateEntries(values: unknown): GitEntry[] {
  if (!Array.isArray(values) || values.length > GITHUB_LIMITS.entries) {
    throw new Error("GitHub tree exceeds the entry limit or is invalid");
  }
  const seen = new Set<string>();
  const entries = values.map((value) => {
    const item = object(value);
    if (
      typeof item.path !== "string" ||
      !safePath(item.path) ||
      seen.has(item.path) ||
      typeof item.type !== "string" ||
      typeof item.mode !== "string"
    ) {
      throw new Error("Unsafe or duplicate GitHub tree path or entry");
    }
    seen.add(item.path);
    const entry: GitEntry = { path: item.path, type: item.type, mode: item.mode, sha: sha(item.sha) };
    if (item.size !== undefined) {
      if (typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0) {
        throw new Error("Invalid GitHub file size");
      }
      entry.size = item.size;
    }
    if (regular(entry) && entry.size === undefined) throw new Error("GitHub file size is missing");
    return entry;
  });
  const paths = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const parts = entry.path.split("/");
    parts.pop();
    while (parts.length) {
      const parent = paths.get(parts.join("/"));
      if (parent && (parent.type !== "tree" || parent.mode !== "040000")) {
        throw new Error("Conflicting GitHub tree paths");
      }
      parts.pop();
    }
  }
  return entries;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("GitHub operation cancelled");
}

function check(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** Also bound injected or stalled transports that do not implement AbortSignal themselves. */
function interruptible<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(abortReason(signal));
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

class Access {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private bytes = 0;
  private readonly fetcher: typeof fetch;

  constructor(dependencies: GitHubDependencies) {
    this.fetcher = dependencies.fetch ?? globalThis.fetch;
  }

  async bytesAt(url: string, limit: number, accept: string): Promise<Uint8Array> {
    check(this.signal);
    const pending = this.fetcher(url, {
      signal: this.signal,
      credentials: "omit",
      redirect: "error",
      headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" },
    });
    // A transport can resolve after cancellation, including the gap between promise
    // resolution and the await continuation. Release the body in both cases.
    let received: Response | undefined;
    void pending.then(
      (response) => {
        received = response;
        if (this.signal.aborted) void response.body?.cancel().catch(() => {});
      },
      () => {},
    );
    let response: Response;
    try {
      response = await interruptible(pending, this.signal);
      check(this.signal);
    } catch (error) {
      void received?.body?.cancel().catch(() => {});
      throw error;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => {
      if (reader) void reader.cancel().catch(() => {});
      else void response.body?.cancel().catch(() => {});
    };
    this.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (!response.ok) {
        const rate = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0";
        throw new Error(
          rate
            ? "GitHub rate limit reached; try again later (no automatic retries)"
            : `GitHub request failed (${response.status}); only public repositories without authentication are supported`,
        );
      }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
        throw new Error("GitHub response exceeds the byte limit");
      }
      if (!response.body) throw new Error("GitHub returned an empty response body");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await interruptible(reader.read(), this.signal);
        check(this.signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        this.bytes += chunk.value.byteLength;
        if (size > limit || this.bytes > GITHUB_LIMITS.totalBytes) {
          throw new Error("GitHub content exceeds the byte limit");
        }
        chunks.push(chunk.value);
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return data;
    } finally {
      this.signal.removeEventListener("abort", cancel);
      cancel();
      reader?.releaseLock();
    }
  }

  async api(path: string): Promise<Record<string, unknown>> {
    const data = await this.bytesAt(
      `https://api.github.com${path}`,
      GITHUB_LIMITS.responseBytes,
      "application/vnd.github+json",
    );
    check(this.signal);
    return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)));
  }

  async tree(repository: string, treeSha: string, recursive: boolean): Promise<GitEntry[]> {
    const response = await this.api(`/repos/${repository}/git/trees/${treeSha}${recursive ? "?recursive=1" : ""}`);
    check(this.signal);
    if (response.truncated !== false) throw new Error("GitHub tree is truncated or incomplete");
    return validateEntries(response.tree);
  }

  async file(
    repository: string,
    commit: string,
    entry: GitEntry,
    limit = GITHUB_LIMITS.fileBytes,
  ): Promise<Uint8Array> {
    if (!regular(entry) || !safePath(entry.path)) throw new Error(`Unsupported file: ${entry.path}`);
    if (entry.size === undefined || entry.size > limit) throw new Error(`File exceeds the byte limit: ${entry.path}`);
    const path = entry.path.split("/").map(encodeURIComponent).join("/");
    const data = await this.bytesAt(
      `https://raw.githubusercontent.com/${repository}/${commit}/${path}`,
      limit,
      "application/octet-stream",
    );
    check(this.signal);
    const hash = createHash("sha1").update(`blob ${data.byteLength}\0`).update(data).digest("hex");
    if (data.byteLength !== entry.size || hash !== entry.sha) {
      throw new Error(`GitHub file does not match the pinned tree: ${entry.path}`);
    }
    return data;
  }
}

async function operation<T>(
  signal: AbortSignal,
  dependencies: GitHubDependencies,
  work: (access: Access) => Promise<T>,
): Promise<T> {
  check(signal);
  const access = new Access(dependencies);
  const cancel = () => access.controller.abort(abortReason(signal));
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => access.controller.abort(new Error("GitHub operation timed out")),
    GITHUB_LIMITS.timeoutMs,
  );
  try {
    const result = await work(access);
    check(signal);
    check(access.signal);
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    access.controller.abort();
  }
}

async function parallel<T, R>(items: readonly T[], access: Access, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;
  const workers = Array.from({ length: Math.min(items.length, GITHUB_LIMITS.parallelism) }, async () => {
    try {
      while (next < items.length) {
        check(access.signal);
        const index = next++;
        results[index] = await work(items[index]);
        check(access.signal);
      }
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
        access.controller.abort(error);
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
  check(access.signal);
  return results;
}

function isNotice(path: string): boolean {
  return /^(licen[cs]e|copying|copyright|notice)(?:[._-].*)?$/i.test(path);
}

function noticeDirectory(path: string): boolean {
  return /^(licenses|licences)$/i.test(path);
}

function bundleEntries(entries: readonly GitEntry[], directory: string): GitEntry[] {
  return entries.filter((entry) => entry.path.startsWith(`${directory}/`));
}

function bundleProblem(entries: readonly GitEntry[]): string | undefined {
  if (entries.some((entry) => !supported(entry)))
    return "Bundle contains a symlink, submodule, or unsupported file type";
  const files = entries.filter(regular);
  if (files.length > GITHUB_LIMITS.filesPerBundle) return "Bundle exceeds the file count limit";
  if (files.some((entry) => entry.size === undefined || entry.size > GITHUB_LIMITS.fileBytes)) {
    return "Bundle exceeds the file byte limit";
  }
  if (files.reduce((size, entry) => size + (entry.size ?? 0), 0) > GITHUB_LIMITS.totalBytes) {
    return "Bundle exceeds the total byte limit";
  }
  return undefined;
}

export async function discoverRepository(
  input: string,
  signal: AbortSignal,
  dependencies: GitHubDependencies = {},
): Promise<RepositorySnapshot> {
  const repository = parseRepository(input);
  return operation(signal, dependencies, async (access) => {
    const repo = await access.api(`/repos/${repository}`);
    check(access.signal);
    if (repo.private !== false) throw new Error("Only public GitHub repositories are supported");
    if (typeof repo.default_branch !== "string" || !repo.default_branch)
      throw new Error("Repository has no default branch");
    const revision = await access.api(`/repos/${repository}/commits/${encodeURIComponent(repo.default_branch)}`);
    check(access.signal);
    const commit = sha(revision.sha);
    const rootSha = sha(object(object(revision.commit).tree).sha);
    const root = await access.tree(repository, rootSha, false);
    check(access.signal);
    const skillsRoot = root.find((entry) => entry.path === "skills");
    if (skillsRoot?.type !== "tree" || skillsRoot.mode !== "040000") {
      throw new Error("Repository has no regular skills/ directory");
    }
    // Do not recursively scan unrelated repository content. Root notices remain applicable.
    const skillTree = await access.tree(repository, skillsRoot.sha, true);
    check(access.signal);
    const entries = [...root, ...skillTree.map((entry) => ({ ...entry, path: `skills/${entry.path}` }))];
    if (entries.length > GITHUB_LIMITS.entries) throw new Error("Repository exceeds the tree entry limit");
    for (const notice of root.filter(
      (entry) =>
        (noticeDirectory(entry.path) || isNotice(entry.path)) && entry.type === "tree" && entry.mode === "040000",
    )) {
      const children = await access.tree(repository, notice.sha, true);
      check(access.signal);
      entries.push(...children.map((entry) => ({ ...entry, path: `${notice.path}/${entry.path}` })));
      if (entries.length > GITHUB_LIMITS.entries) throw new Error("Repository exceeds the tree entry limit");
    }
    validateEntries(entries);
    const roots = skillTree
      .filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"))
      .map((entry) => ({
        entry: { ...entry, path: `skills/${entry.path}` },
        directory: `skills/${entry.path}`.slice(0, -"/SKILL.md".length),
      }))
      .sort(
        (left, right) =>
          left.directory.length - right.directory.length || left.directory.localeCompare(right.directory),
      );
    const candidates: typeof roots = [];
    for (const root of roots) {
      if (!candidates.some((parent) => root.directory.startsWith(`${parent.directory}/`))) candidates.push(root);
      if (candidates.length > GITHUB_LIMITS.candidates) throw new Error("Repository exceeds the skill candidate limit");
    }
    const skills = await parallel(candidates, access, async ({ directory, entry }): Promise<RemoteSkill> => {
      const directoryName = directory.split("/").at(-1) as string;
      const base = {
        id: `${directory}@${commit}`,
        directory,
        directoryName,
        name: directoryName,
        description: "",
        content: "",
        warnings: [] as string[],
      };
      const bundle = bundleEntries(entries, directory);
      const notices = applicableNotices(entries, directory);
      const problem =
        bundleProblem(bundle) ??
        bundleProblem(notices) ??
        (bundle.filter(regular).length + notices.filter(regular).length > GITHUB_LIMITS.filesPerBundle
          ? "Bundle and repository notices exceed the file count limit"
          : undefined);
      if (!regular(entry) || (entry.size ?? Infinity) > GITHUB_LIMITS.metadataBytes) {
        return { ...base, disabledReason: "SKILL.md is unsupported or exceeds the metadata byte limit" };
      }
      const data = await access.file(repository, commit, entry, GITHUB_LIMITS.metadataBytes);
      check(access.signal);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        return { ...base, disabledReason: "SKILL.md is not valid UTF-8" };
      }
      return {
        ...base,
        content,
        ...inspectMetadata(content, directoryName),
        ...(problem ? { disabledReason: problem } : {}),
      };
    });
    check(access.signal);
    return { repository, commit, skills, entries };
  });
}

function applicableNotices(entries: readonly GitEntry[], directory: string): GitEntry[] {
  const ancestors = new Set<string>([""]);
  const parts = directory.split("/");
  parts.pop();
  while (parts.length) {
    ancestors.add(parts.join("/"));
    parts.pop();
  }
  return entries.filter((entry) => {
    // Notices inside the selected directory already belong to the complete bundle.
    if (entry.path === directory || entry.path.startsWith(`${directory}/`)) return false;
    const path = entry.path.split("/");
    const name = path.pop() as string;
    if (ancestors.has(path.join("/")) && (isNotice(name) || noticeDirectory(name))) return true;
    return path.some(
      (part, index) => (noticeDirectory(part) || isNotice(part)) && ancestors.has(path.slice(0, index).join("/")),
    );
  });
}

export async function downloadBundles(
  snapshot: RepositorySnapshot,
  selectedIds: readonly string[],
  signal: AbortSignal,
  dependencies: GitHubDependencies = {},
): Promise<SkillBundle[]> {
  check(signal);
  // Copy caller-owned mutable data before the first await. Validate identity instead of trusting labels.
  const repository = parseRepository(snapshot.repository);
  const commit = sha(snapshot.commit);
  const entries = validateEntries(snapshot.entries);
  const ids = [...new Set(selectedIds)];
  if (ids.length > GITHUB_LIMITS.candidates) throw new Error("Selection exceeds the candidate limit");
  const selected = ids.map((id) => {
    const skill = snapshot.skills.find((candidate) => candidate.id === id);
    if (
      !skill ||
      id !== `${skill.directory}@${commit}` ||
      !safePath(skill.directory) ||
      (skill.directory !== "skills" && !skill.directory.startsWith("skills/")) ||
      skill.directoryName !== skill.directory.split("/").at(-1)
    ) {
      throw new Error("Selected skill does not belong to this repository snapshot");
    }
    if (skill.disabledReason) throw new Error(`Skill is not installable: ${skill.disabledReason}`);
    const files = bundleEntries(entries, skill.directory);
    const problem = bundleProblem(files);
    if (problem) throw new Error(problem);
    const declared = files.find((entry) => entry.path === `${skill.directory}/SKILL.md`);
    if (!declared || !regular(declared)) throw new Error("Selected bundle has no regular SKILL.md");
    if ((declared.size ?? Infinity) > GITHUB_LIMITS.metadataBytes)
      throw new Error("SKILL.md exceeds the metadata byte limit");
    // A nested SKILL.md is supporting content, never another selectable skill.
    if (
      entries.some(
        (entry) =>
          entry.path.endsWith("/SKILL.md") &&
          skill.directory.startsWith(`${entry.path.slice(0, -"/SKILL.md".length)}/`),
      )
    ) {
      throw new Error("Selected skill is nested inside another skill bundle");
    }
    const notices = applicableNotices(entries, skill.directory);
    const noticeProblem = bundleProblem(notices);
    if (noticeProblem) throw new Error(`Repository notices are unsafe: ${noticeProblem}`);
    return {
      id,
      directory: skill.directory,
      directoryName: skill.directoryName,
      files: files.filter(regular),
      notices: notices.filter(regular),
    };
  });
  const totalFiles = selected.flatMap((skill) => [...skill.files, ...skill.notices]);
  if (
    totalFiles.length > GITHUB_LIMITS.files ||
    selected.some((skill) => skill.files.length + skill.notices.length > GITHUB_LIMITS.filesPerBundle)
  ) {
    throw new Error("Selection exceeds the file count limit");
  }
  if (totalFiles.reduce((bytes, file) => bytes + (file.size ?? 0), 0) > GITHUB_LIMITS.totalBytes) {
    throw new Error("Selection exceeds the total byte limit");
  }
  return operation(signal, dependencies, async (access) => {
    // Flatten the work to enforce one parallelism limit across all selected bundles.
    const unique = [...new Map(totalFiles.map((entry) => [entry.path, entry])).values()];
    const downloaded = await parallel(unique, access, async (entry) => ({
      entry,
      content: await access.file(repository, commit, entry),
    }));
    check(access.signal);
    const contents = new Map(downloaded.map((file) => [file.entry.path, file.content]));
    return selected.map((skill) => {
      check(access.signal);
      const markdown = contents.get(`${skill.directory}/SKILL.md`) as Uint8Array;
      new TextDecoder("utf-8", { fatal: true }).decode(markdown);
      let reserved = ".pi-skills-notices";
      let suffix = 0;
      const relativePaths = skill.files.map((file) => file.path.slice(skill.directory.length + 1));
      while (
        relativePaths.some((path) => path.toLowerCase() === reserved || path.toLowerCase().startsWith(`${reserved}/`))
      ) {
        reserved = `.pi-skills-notices-${++suffix}`;
      }
      const files: BundleFile[] = [
        ...skill.files.map((entry) => ({
          path: entry.path.slice(skill.directory.length + 1),
          content: contents.get(entry.path) as Uint8Array,
          executable: entry.mode === "100755",
        })),
        ...skill.notices.map((entry) => ({
          path: `${reserved}/${entry.path}`,
          content: contents.get(entry.path) as Uint8Array,
          executable: entry.mode === "100755",
        })),
      ];
      const metadata = inspectBundleMetadata(files, skill.directoryName);
      if (metadata.disabledReason) throw new Error(`Skill is not installable: ${metadata.disabledReason}`);
      return {
        id: skill.id,
        directoryName: skill.directoryName,
        name: metadata.name,
        files,
        warnings: metadata.warnings,
      };
    });
  });
}
