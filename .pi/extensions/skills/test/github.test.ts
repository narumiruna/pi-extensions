import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverRepository, downloadBundles, GITHUB_LIMITS, parseRepository } from "../github.ts";
import type { GitEntry, RepositorySnapshot } from "../types.ts";

const COMMIT = "c".repeat(40);
const ROOT = "a".repeat(40);
const REPOSITORY = "owner/repo";
const encode = (content: string) => new TextEncoder().encode(content);
const markdown = (name = "declared") => `---\nname: ${name}\ndescription: Example skill.\n---\nInstructions.\n`;
const blobHash = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const treeHash = (path: string) => createHash("sha1").update(path).digest("hex");
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

interface SourceFile {
  content: string | Uint8Array;
  mode?: string;
  type?: string;
}

function fixture(files: Record<string, string | SourceFile> = { "skills/default/example/SKILL.md": markdown() }) {
  const entries: GitEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  for (const [path, input] of Object.entries(files)) {
    const file = typeof input === "string" ? { content: input } : input;
    const data = typeof file.content === "string" ? encode(file.content) : file.content;
    bytes.set(path, data);
    entries.push({
      path,
      mode: file.mode ?? "100644",
      type: file.type ?? "blob",
      size: data.length,
      sha: blobHash(data),
    });
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      directories.add(parts.join("/"));
      parts.pop();
    }
  }
  for (const path of directories) entries.push({ path, mode: "040000", type: "tree", sha: treeHash(path) });
  const route = (input: string | URL | Request): Response => {
    const url = String(input);
    if (url === `https://api.github.com/repos/${REPOSITORY}`)
      return json({ private: false, default_branch: "feature/default" });
    if (url === `https://api.github.com/repos/${REPOSITORY}/commits/feature%2Fdefault`) {
      return json({ sha: COMMIT, commit: { tree: { sha: ROOT } } });
    }
    if (url === `https://api.github.com/repos/${REPOSITORY}/git/trees/${ROOT}`) {
      return json({ truncated: false, tree: entries.filter((entry) => !entry.path.includes("/")) });
    }
    for (const directory of directories) {
      if (url === `https://api.github.com/repos/${REPOSITORY}/git/trees/${treeHash(directory)}?recursive=1`) {
        return json({
          truncated: false,
          tree: entries
            .filter((entry) => entry.path.startsWith(`${directory}/`))
            .map((entry) => ({ ...entry, path: entry.path.slice(directory.length + 1) })),
        });
      }
    }
    const prefix = `https://raw.githubusercontent.com/${REPOSITORY}/${COMMIT}/`;
    if (url.startsWith(prefix)) {
      const path = url.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
      const content = bytes.get(path);
      if (content) return new Response(Uint8Array.from(content));
    }
    throw new Error(`Unexpected test request: ${url}`);
  };
  const fetcher = vi.fn<typeof fetch>(async (input) => route(input));
  return { fetch: fetcher, route, entries, bytes };
}

const signal = () => new AbortController().signal;
const discover = (source: ReturnType<typeof fixture>) => discoverRepository(REPOSITORY, signal(), source);
const rawCalls = (source: ReturnType<typeof fixture>) =>
  source.fetch.mock.calls.filter(([url]) => String(url).startsWith("https://raw."));

function snapshot(entries: GitEntry[]): RepositorySnapshot {
  return {
    repository: REPOSITORY,
    commit: COMMIT,
    entries,
    skills: [
      {
        id: `skills/example@${COMMIT}`,
        directory: "skills/example",
        directoryName: "example",
        name: "declared",
        description: "Example skill.",
        content: markdown(),
        warnings: [],
      },
    ],
  };
}

afterEach(() => vi.useRealTimers());

describe("repository inputs", () => {
  it.each(["owner/repo", "Owner-1/repo.name_2", "https://github.com/owner/repo"])("accepts %s", (input) => {
    expect(parseRepository(input)).toBe(input.replace("https://github.com/", ""));
  });
  it.each([
    "",
    "owner",
    "owner/repo/",
    "owner/repo/extra",
    "owner/repo extra",
    " owner/repo",
    "owner/repo ",
    "owner/.",
    "owner/..",
    "owner/repo.git",
    "-owner/repo",
    "owner-/repo",
    "own_er/repo",
    "https://github.com/owner/repo/",
    "https://github.com/owner/repo/tree/main",
    "https://github.com/owner/repo?x=1",
    "https://github.com/owner/repo#readme",
    "https://user:password@github.com/owner/repo",
    "https://github.com:443/owner/repo",
    "https://github.com.evil/owner/repo",
    "http://github.com/owner/repo",
    "https://gitlab.com/owner/repo",
    "git@github.com:owner/repo",
    "https://github.com/owner/../repo",
    "https://github.com/owner/%72epo",
    "owner\\repo",
    "owner/repo\n",
  ])("rejects %s", (input) => expect(() => parseRepository(input)).toThrow());
});

describe("commit-pinned discovery", () => {
  it("recurses only below skills/, stops at skill roots, and keeps path+commit identities", async () => {
    const source = fixture({
      "skills/default/first/SKILL.md": markdown("same-name"),
      "skills/optional/second/SKILL.md": markdown("same-name"),
      "skills/default/first/nested/SKILL.md": markdown("not-a-candidate"),
      "elsewhere/SKILL.md": markdown("not-discovered"),
      "README.md": "Not a skill.",
    });
    const result = await discover(source);
    expect(result.skills.map((skill) => skill.directory).sort()).toEqual([
      "skills/default/first",
      "skills/optional/second",
    ]);
    expect(result.skills.map((skill) => skill.name)).toEqual(["same-name", "same-name"]);
    expect(new Set(result.skills.map((skill) => skill.id)).size).toBe(2);
    expect(result.skills.every((skill) => skill.id === `${skill.directory}@${COMMIT}`)).toBe(true);
    expect(result.entries.some((entry) => entry.path === "skills/default/first/nested/SKILL.md")).toBe(true);
    expect(result.entries.some((entry) => entry.path === "elsewhere/SKILL.md")).toBe(false);
    expect(source.fetch.mock.calls.filter(([url]) => String(url).includes("/commits/"))).toHaveLength(1);
    expect(rawCalls(source)).toHaveLength(2);
    for (const [url, options] of source.fetch.mock.calls) {
      expect(options?.credentials).toBe("omit");
      expect(options?.redirect).toBe("error");
      expect(new Headers(options?.headers).has("authorization")).toBe(false);
      if (String(url).startsWith("https://raw.")) expect(String(url)).toContain(`/${COMMIT}/`);
    }
  });

  it("supports skills/ itself as the bundle root", async () => {
    const result = await discover(fixture({ "skills/SKILL.md": markdown(), "skills/nested/SKILL.md": markdown() }));
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].directory).toBe("skills");
    expect(result.skills[0].directoryName).toBe("skills");
  });

  it("retains invalid declared files and native warnings for read-only previews", async () => {
    const result = await discover(
      fixture({
        "skills/broken/SKILL.md": "---\ndescription: [\n---",
        "skills/missing/SKILL.md": "Instructions.",
        "skills/warning/SKILL.md": markdown("Bad--name"),
      }),
    );
    expect(result.skills.find((skill) => skill.directoryName === "broken")?.disabledReason).toBeTruthy();
    expect(result.skills.find((skill) => skill.directoryName === "missing")?.disabledReason).toContain("description");
    const warning = result.skills.find((skill) => skill.directoryName === "warning");
    expect(warning?.warnings).toHaveLength(2);
    expect(warning?.disabledReason).toBeUndefined();
    expect(warning?.name).toBe("Bad--name");
  });

  it.each([
    { mode: "120000", type: "blob" },
    { mode: "160000", type: "commit" },
    { mode: "100600", type: "blob" },
    { mode: "040000", type: "unexpected" },
  ])("disables the entire bundle for unsupported supporting entries: %j", async (unsupported) => {
    const source = fixture({
      "skills/example/SKILL.md": markdown(),
      "skills/example/support": { content: "data", ...unsupported },
    });
    const result = await discover(source);
    expect(result.skills[0].disabledReason).toContain("unsupported file type");
    expect(result.skills[0].content).toBe(markdown());
    expect(result.skills[0].name).toBe("declared");
    await expect(downloadBundles(result, [result.skills[0].id], signal(), source)).rejects.toThrow("not installable");
  });

  it("never follows symlinked SKILL.md files", async () => {
    const source = fixture({ "skills/example/SKILL.md": { content: "../../elsewhere", mode: "120000" } });
    const result = await discover(source);
    expect(result.skills[0].disabledReason).toBeTruthy();
    expect(rawCalls(source)).toHaveLength(0);
  });

  it("disables invalid UTF-8 metadata", async () => {
    const result = await discover(fixture({ "skills/example/SKILL.md": { content: new Uint8Array([255]) } }));
    expect(result.skills[0].disabledReason).toContain("UTF-8");
  });

  it("rejects a missing skills/ root instead of scanning elsewhere", async () => {
    const source = fixture({ "elsewhere/SKILL.md": markdown() });
    await expect(discover(source)).rejects.toThrow("skills/");
    expect(rawCalls(source)).toHaveLength(0);
  });

  it.each(["root", "skills"])("rejects truncated %s trees", async (level) => {
    const source = fixture();
    source.fetch.mockImplementation(async (url) => {
      if (String(url).includes(`/git/trees/${level === "root" ? ROOT : treeHash("skills")}`))
        return json({ truncated: true, tree: [] });
      return source.route(url);
    });
    await expect(discover(source)).rejects.toThrow("truncated");
  });

  it.each([
    "../escape",
    "/absolute",
    "example/../../escape",
    "example\\escape",
    "example/evil\u001b",
    "example/CON",
    "example/.git/config",
    "example/a:b",
    "example/ending.",
  ])("rejects unsafe tree paths: %s", async (path) => {
    const source = fixture();
    source.fetch.mockImplementation(async (url) =>
      String(url).includes(`${treeHash("skills")}?recursive=1`)
        ? json({ truncated: false, tree: [{ path, mode: "100644", type: "blob", sha: COMMIT, size: 0 }] })
        : source.route(url),
    );
    await expect(discover(source)).rejects.toThrow("Unsafe");
  });

  it("rejects duplicate tree paths", async () => {
    const source = fixture();
    source.fetch.mockImplementation(async (url) =>
      String(url).includes(`${treeHash("skills")}?recursive=1`)
        ? json({
            truncated: false,
            tree: [0, 1].map(() => ({ path: "example/SKILL.md", mode: "100644", type: "blob", sha: COMMIT, size: 0 })),
          })
        : source.route(url),
    );
    await expect(discover(source)).rejects.toThrow("duplicate");
  });

  it("bounds candidate count before starting metadata downloads", async () => {
    const source = fixture(
      Object.fromEntries(
        Array.from({ length: GITHUB_LIMITS.candidates + 1 }, (_, index) => [
          `skills/skill-${index}/SKILL.md`,
          markdown(),
        ]),
      ),
    );
    await expect(discover(source)).rejects.toThrow("candidate limit");
    expect(rawCalls(source)).toHaveLength(0);
  });

  it("bounds metadata bytes before requesting a large file", async () => {
    const source = fixture({ "skills/large/SKILL.md": "x".repeat(GITHUB_LIMITS.metadataBytes + 1) });
    expect((await discover(source)).skills[0].disabledReason).toContain("metadata byte limit");
    expect(rawCalls(source)).toHaveLength(0);
  });

  it("rejects private repository responses", async () => {
    const source = fixture();
    source.fetch.mockResolvedValue(json({ private: true, default_branch: "main" }));
    await expect(discover(source)).rejects.toThrow("public");
    expect(source.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429])("reports rate limits without retrying: %i", async (status) => {
    const source = fixture();
    source.fetch.mockResolvedValue(new Response("Rate limit", { status, headers: { "x-ratelimit-remaining": "0" } }));
    await expect(discover(source)).rejects.toThrow("rate limit");
    expect(source.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 500])("reports permission/server errors without retries: %i", async (status) => {
    const source = fixture();
    source.fetch.mockResolvedValue(new Response("Error", { status }));
    await expect(discover(source)).rejects.toThrow(`(${status})`);
    expect(source.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("complete bundle downloads", () => {
  it("preserves exact bytes, executable bits, nested content and applicable notices without collisions", async () => {
    const script = new Uint8Array([0, 255, 10, 13, 32]);
    const source = fixture({
      "skills/category/original/SKILL.md": markdown("different-name"),
      "skills/category/original/scripts/run.sh": { content: script, mode: "100755" },
      "skills/category/original/references/exact.txt": "  exact\r\n\tbytes\n",
      "skills/category/original/nested/SKILL.md": markdown("support-only"),
      "skills/category/original/.pi-skills-notices/keep": "Existing skill content.",
      "skills/category/LICENSE": "Category license",
      "skills/NOTICE.txt": "Skills notice",
      LICENSE: "Root license",
      "NOTICE.md": "Root notice",
      "LICENSES/MIT.txt": "SPDX license",
      "unrelated/LICENSE": "Not applicable",
    });
    const result = await discover(source);
    source.fetch.mockClear();
    const bundles = await downloadBundles(result, [result.skills[0].id], signal(), source);
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0];
    expect(bundle.directoryName).toBe("original");
    expect(bundle.name).toBe("different-name");
    const files = new Map(bundle.files.map((file) => [file.path, file]));
    expect(files.get("scripts/run.sh")).toEqual({ path: "scripts/run.sh", content: script, executable: true });
    expect(files.get("references/exact.txt")?.content).toEqual(encode("  exact\r\n\tbytes\n"));
    expect(files.has("nested/SKILL.md")).toBe(true);
    expect(files.get(".pi-skills-notices/keep")?.content).toEqual(encode("Existing skill content."));
    expect(files.get(".pi-skills-notices-1/LICENSE")?.content).toEqual(encode("Root license"));
    expect(files.has(".pi-skills-notices-1/NOTICE.md")).toBe(true);
    expect(files.has(".pi-skills-notices-1/skills/category/LICENSE")).toBe(true);
    expect(files.has(".pi-skills-notices-1/skills/NOTICE.txt")).toBe(true);
    expect(files.has(".pi-skills-notices-1/LICENSES/MIT.txt")).toBe(true);
    expect(bundle.files.some((file) => file.path.includes("unrelated"))).toBe(false);
    expect(source.fetch.mock.calls.every(([url]) => String(url).includes(`/${COMMIT}/`))).toBe(true);
  });

  it("downloads only selected bundles and deduplicates selected raw IDs", async () => {
    const source = fixture({ "skills/first/SKILL.md": markdown(), "skills/second/SKILL.md": markdown() });
    const result = await discover(source);
    source.fetch.mockClear();
    const id = result.skills[0].id;
    expect(await downloadBundles(result, [id, id], signal(), source)).toHaveLength(1);
    expect(source.fetch).toHaveBeenCalledTimes(1);
    expect(String(source.fetch.mock.calls[0][0])).toContain(result.skills[0].directory);
  });

  it("keeps an empty selection empty without network requests", async () => {
    const source = fixture();
    const result = await discover(source);
    source.fetch.mockClear();
    expect(await downloadBundles(result, [], signal(), source)).toEqual([]);
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it("rejects stale or fabricated selection identities", async () => {
    const source = fixture();
    const result = await discover(source);
    await expect(downloadBundles(result, [result.skills[0].name], signal(), source)).rejects.toThrow("snapshot");
    result.skills[0].directoryName = "renamed";
    await expect(downloadBundles(result, [result.skills[0].id], signal(), source)).rejects.toThrow("snapshot");
  });

  it("rejects corruption instead of installing bytes outside the pinned tree", async () => {
    const source = fixture();
    const result = await discover(source);
    source.fetch.mockResolvedValue(new Response("Tampered."));
    await expect(downloadBundles(result, [result.skills[0].id], signal(), source)).rejects.toThrow("pinned tree");
  });

  it("does not trust cached preview metadata during download validation", async () => {
    const source = fixture({ "skills/example/SKILL.md": "No description." });
    const state = snapshot(source.entries);
    await expect(downloadBundles(state, [state.skills[0].id], signal(), source)).rejects.toThrow("description");
  });

  it("copies caller-owned snapshot data before asynchronous download work", async () => {
    const source = fixture({ "skills/example/SKILL.md": markdown() });
    const result = await discover(source);
    source.fetch.mockImplementation(async (url) => {
      result.skills[0].directoryName = "attacker-name";
      result.entries.length = 0;
      return source.route(url);
    });
    const bundles = await downloadBundles(result, [result.skills[0].id], signal(), source);
    expect(bundles[0].directoryName).toBe("example");
    expect(bundles[0].files).toHaveLength(1);
  });

  it.each(["LICENSE", "LICENSES"])("disables unsafe root notice %s", async (path) => {
    const source = fixture({ "skills/example/SKILL.md": markdown(), [path]: { content: "elsewhere", mode: "120000" } });
    const result = await discover(source);
    expect(result.skills[0].disabledReason).toContain("symlink");
    expect(rawCalls(source).some(([url]) => String(url).endsWith(`/${path}`))).toBe(false);
  });

  it("bounds file counts before requests", async () => {
    const source = fixture(
      Object.fromEntries([
        ["skills/example/SKILL.md", markdown()],
        ...Array.from({ length: GITHUB_LIMITS.filesPerBundle }, (_, index) => [
          `skills/example/file-${index}`,
          "support",
        ]),
      ]),
    );
    const result = await discover(source);
    expect(result.skills[0].disabledReason).toContain("file count");
    source.fetch.mockClear();
    const state = snapshot(source.entries);
    await expect(downloadBundles(state, [state.skills[0].id], signal(), source)).rejects.toThrow("file count");
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it("bounds file and selection bytes before requests", async () => {
    const source = fixture({ "skills/example/SKILL.md": markdown(), "skills/example/large": "support" });
    const state = snapshot(source.entries);
    const large = state.entries.find((entry) => entry.path.endsWith("/large")) as GitEntry;
    large.size = GITHUB_LIMITS.fileBytes + 1;
    await expect(downloadBundles(state, [state.skills[0].id], signal(), source)).rejects.toThrow("byte limit");
    large.size = GITHUB_LIMITS.fileBytes;
    for (let index = 0; index < 9; index++) state.entries.push({ ...large, path: `skills/example/large-${index}` });
    await expect(downloadBundles(state, [state.skills[0].id], signal(), source)).rejects.toThrow("byte limit");
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it("enforces parallelism across the whole selection", async () => {
    const source = fixture(
      Object.fromEntries(
        Array.from({ length: GITHUB_LIMITS.parallelism + 3 }, (_, index) => [
          `skills/skill-${index}/SKILL.md`,
          markdown(),
        ]),
      ),
    );
    const result = await discover(source);
    let active = 0;
    let maximum = 0;
    source.fetch.mockImplementation(async (url) => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return source.route(url);
    });
    expect(
      await downloadBundles(
        result,
        result.skills.map((skill) => skill.id),
        signal(),
        source,
      ),
    ).toHaveLength(result.skills.length);
    expect(maximum).toBe(GITHUB_LIMITS.parallelism);
  });
});

describe("additional safety limits", () => {
  it.each([".gitignore", ".ignore", ".fdignore"])(
    "validates complete bundle %s rules before returning installable data",
    async (ignore) => {
      const source = fixture({ "skills/example/SKILL.md": markdown(), [`skills/example/${ignore}`]: "SKILL.md\n" });
      const result = await discover(source);
      await expect(downloadBundles(result, [result.skills[0].id], signal(), source)).rejects.toThrow("Pi did not load");
    },
  );

  it("bounds the recursive tree entry count", async () => {
    const source = fixture();
    source.fetch.mockImplementation(async (url) =>
      String(url).includes(`${treeHash("skills")}?recursive=1`)
        ? json({
            truncated: false,
            tree: Array.from({ length: GITHUB_LIMITS.entries + 1 }, (_, index) => ({
              path: `file-${index}`,
              type: "blob",
              mode: "100644",
              sha: COMMIT,
              size: 0,
            })),
          })
        : source.route(url),
    );
    await expect(discover(source)).rejects.toThrow("entry limit");
    expect(rawCalls(source)).toHaveLength(0);
  });

  it("rejects a symlink or blob used as the ancestor of another entry", async () => {
    const source = fixture();
    source.fetch.mockImplementation(async (url) =>
      String(url).includes(`${treeHash("skills")}?recursive=1`)
        ? json({
            truncated: false,
            tree: [
              { path: "category", type: "blob", mode: "120000", sha: COMMIT, size: 0 },
              { path: "category/example/SKILL.md", type: "blob", mode: "100644", sha: COMMIT, size: 0 },
            ],
          })
        : source.route(url),
    );
    await expect(discover(source)).rejects.toThrow("Conflicting");
  });

  it("bounds the selection-wide file count independently of per-bundle limits", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, skill) => [
        [`skills/skill-${skill}/SKILL.md`, markdown()],
        ...Array.from({ length: 420 }, (_, index) => [`skills/skill-${skill}/file-${index}`, "data"]),
      ]).flat(),
    );
    const source = fixture(files);
    const result = await discover(source);
    source.fetch.mockClear();
    await expect(
      downloadBundles(
        result,
        result.skills.map((skill) => skill.id),
        signal(),
        source,
      ),
    ).rejects.toThrow("file count");
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it("enforces total streamed network bytes across individually bounded responses", async () => {
    const source = fixture({ "skills/example/SKILL.md": markdown(), "LICENSES/MIT.txt": "License" });
    const padding = " ".repeat(GITHUB_LIMITS.responseBytes - 2000);
    source.fetch.mockImplementation(async (url) => {
      const payload = (await source.route(url).json()) as Record<string, unknown>;
      return json({ ...payload, padding });
    });
    await expect(discover(source)).rejects.toThrow("byte limit");
    expect(source.fetch).toHaveBeenCalledTimes(5);
    expect(rawCalls(source)).toHaveLength(0);
  });

  it("rejects selected skills hidden under another declared bundle", async () => {
    const source = fixture({ "skills/example/SKILL.md": markdown(), "skills/example/nested/SKILL.md": markdown() });
    const state = snapshot(source.entries);
    state.skills[0] = {
      ...state.skills[0],
      id: `skills/example/nested@${COMMIT}`,
      directory: "skills/example/nested",
      directoryName: "nested",
    };
    await expect(downloadBundles(state, [state.skills[0].id], signal(), source)).rejects.toThrow("nested");
  });
});

describe("network bounds and cancellation", () => {
  it("rejects cancellation before making a request", async () => {
    const source = fixture();
    const controller = new AbortController();
    controller.abort(new Error("User cancelled"));
    await expect(discoverRepository(REPOSITORY, controller.signal, source)).rejects.toThrow("User cancelled");
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it("aborts pending header requests and ignores late responses without leaking bodies", async () => {
    const source = fixture();
    const controller = new AbortController();
    let complete: ((response: Response) => void) | undefined;
    source.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const task = discoverRepository(REPOSITORY, controller.signal, source);
    const outcome = expect(task).rejects.toThrow("Cancelled headers");
    const requestSignal = source.fetch.mock.calls[0][1]?.signal;
    controller.abort(new Error("Cancelled headers"));
    await outcome;
    expect(requestSignal?.aborted).toBe(true);
    const cancel = vi.fn();
    complete?.(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("releases a response cancelled between header resolution and the await continuation", async () => {
    const source = fixture();
    const controller = new AbortController();
    const cancel = vi.fn();
    source.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const task = discoverRepository(REPOSITORY, controller.signal, source);
    const outcome = expect(task).rejects.toThrow("Cancelled continuation");
    queueMicrotask(() => controller.abort(new Error("Cancelled continuation")));
    await outcome;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a body reader, not only the completed header request", async () => {
    const source = fixture();
    const controller = new AbortController();
    const cancel = vi.fn();
    let reading: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      reading = resolve;
    });
    source.fetch.mockResolvedValue(
      new Response(
        new ReadableStream(
          {
            pull() {
              reading?.();
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    const task = discoverRepository(REPOSITORY, controller.signal, source);
    const outcome = expect(task).rejects.toThrow("Cancelled body");
    await ready;
    controller.abort(new Error("Cancelled body"));
    await outcome;
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.fetch).toHaveBeenCalledOnce();
  });

  it("bounds total operation time even when an injected transport stalls", async () => {
    vi.useFakeTimers();
    const source = fixture();
    source.fetch.mockImplementation(() => new Promise(() => {}));
    const task = discover(source);
    const outcome = expect(task).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(GITHUB_LIMITS.timeoutMs);
    await outcome;
    expect(source.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the operation deadline active while reading a stalled body", async () => {
    vi.useFakeTimers();
    const source = fixture();
    const cancel = vi.fn();
    let reading: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      reading = resolve;
    });
    source.fetch.mockResolvedValue(
      new Response(
        new ReadableStream(
          {
            pull() {
              reading?.();
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    const task = discover(source);
    const outcome = expect(task).rejects.toThrow("timed out");
    await ready;
    await vi.advanceTimersByTimeAsync(GITHUB_LIMITS.timeoutMs);
    await outcome;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds streamed bytes without relying on content-length", async () => {
    const source = fixture();
    const cancel = vi.fn();
    source.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(GITHUB_LIMITS.responseBytes + 1));
          },
          cancel,
        }),
      ),
    );
    await expect(discover(source)).rejects.toThrow("byte limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects excessive declared response length and releases the body", async () => {
    const source = fixture();
    const cancel = vi.fn();
    source.fetch.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-length": String(GITHUB_LIMITS.responseBytes + 1) },
      }),
    );
    await expect(discover(source)).rejects.toThrow("byte limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts concurrent file bodies after the first download failure", async () => {
    const source = fixture({ "skills/example/SKILL.md": markdown(), "skills/example/support": "support" });
    const result = await discover(source);
    const cancel = vi.fn();
    source.fetch.mockImplementation(async (url) =>
      String(url).endsWith("/support")
        ? new Response(new ReadableStream({ cancel }))
        : new Response("Failure", { status: 429 }),
    );
    await expect(downloadBundles(result, [result.skills[0].id], signal(), source)).rejects.toThrow("rate limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.fetch.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
  });
});
