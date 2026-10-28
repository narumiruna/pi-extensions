import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultResourceLoader,
  SettingsManager,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRegistration, customLocation, loadLocations, previewRegistration } from "../locations.ts";
import type { Environment, Guard, RegistrationPlan } from "../types.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

let temp: string;
let env: Environment;
let guard: Guard;
let trusted: boolean;
let owned: boolean;
let userFile: string;
let projectFile: string;

beforeEach(async () => {
  temp = await fs.mkdtemp(join(tmpdir(), "pi-skills-locations-"));
  trusted = true;
  owned = true;
  env = {
    cwd: join(temp, "workspace", "nested"),
    homeDir: join(temp, "home"),
    agentDir: join(temp, "agent-override"),
    isProjectTrusted: () => trusted,
  };
  guard = {
    signal: new AbortController().signal,
    check: () => {
      if (!owned) throw new Error("Owner changed");
    },
    isProjectTrusted: () => trusted,
  };
  userFile = join(env.agentDir, "settings.json");
  projectFile = join(env.cwd, CONFIG_DIR_NAME, "settings.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(fs.readFile).mockReset();
  vi.mocked(fs.readFile).mockImplementation(
    (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).readFile,
  );
  await fs.rm(temp, { recursive: true, force: true });
});

async function put(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value));
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

async function plan(root: string, scope: "project" | "user" = "project"): Promise<RegistrationPlan> {
  const result = await previewRegistration(root, scope, env, guard);
  expect(result).toBeDefined();
  return result as RegistrationPlan;
}

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("target roots", () => {
  it("returns four cwd-based defaults and honors the agent directory without creating absent directories", async () => {
    const create = vi.spyOn(SettingsManager, "create");
    const result = await loadLocations(env, guard);
    expect(result.warnings).toEqual([]);
    expect(result.locations.map(({ id, path }) => [id, path])).toEqual([
      ["project-pi", join(env.cwd, CONFIG_DIR_NAME, "skills")],
      ["user-pi", join(env.agentDir, "skills")],
      ["project-shared", join(env.cwd, ".agents", "skills")],
      ["user-shared", join(env.homeDir, ".agents", "skills")],
    ]);
    expect(create).toHaveBeenCalledWith(env.cwd, env.agentDir, { projectTrusted: true });
    expect(await fs.readdir(temp)).toEqual([]);
  });

  it.each([false, true])(
    "does not deadlock when agent settings and project settings share a file (alias=%s)",
    async (alias) => {
      await put(projectFile, { skills: ["custom"] });
      if (alias) {
        await fs.symlink(join(env.cwd, CONFIG_DIR_NAME), env.agentDir);
      } else {
        env.agentDir = join(env.cwd, CONFIG_DIR_NAME);
      }
      const result = await loadLocations(env, guard);
      expect(result.warnings).toEqual([]);
      expect(
        result.locations.filter((location) => location.path === join(env.cwd, CONFIG_DIR_NAME, "custom")),
      ).toHaveLength(1);
    },
  );

  it("does not honor untrusted project settings or grant native trust", async () => {
    trusted = false;
    await put(projectFile, { skills: ["../../forbidden"] });
    const before = await fs.readFile(projectFile, "utf8");
    const create = vi.spyOn(SettingsManager, "create");
    const result = await loadLocations(env, guard);
    expect(result.locations).toHaveLength(4);
    expect(
      result.locations
        .filter((location) => location.scope === "project")
        .every((location) => location.readOnlyReason?.includes("trust")),
    ).toBe(true);
    expect(create).toHaveBeenCalledWith(env.cwd, env.agentDir, { projectTrusted: false });
    expect(await fs.readFile(projectFile, "utf8")).toBe(before);
    expect(existsSync(env.agentDir)).toBe(false);
    await expect(previewRegistration(join(env.cwd, "custom"), "project", env, guard)).rejects.toThrow("trust");
  });

  it("uses both scope-local arrays, deduplicates directories, and excludes filters, globs and files", async () => {
    const duplicate = join(temp, "shared-root");
    const markdown = join(temp, "standalone.md");
    await put(markdown, "not a container");
    await put(userFile, {
      skills: [
        "relative-user",
        "~/shared",
        duplicate,
        "+included",
        "-excluded",
        "!**/hidden",
        "glob*",
        "glob?",
        "[ab]",
        "{a,b}",
        "",
        markdown,
        join(env.agentDir, "skills"),
      ],
    });
    await put(projectFile, { skills: ["relative-project", duplicate] });
    const result = await loadLocations(env, guard);
    expect(result.warnings).toEqual([]);
    expect(result.locations.slice(4).map((location) => location.path)).toEqual([
      join(env.agentDir, "relative-user"),
      join(env.homeDir, "shared"),
      duplicate,
      join(env.cwd, CONFIG_DIR_NAME, "relative-project"),
    ]);
    expect(result.locations.at(-1)?.scope).toBe("project");
  });

  it("marks linked roots and linked parents read-only, including absent child containers", async () => {
    const real = join(temp, "real");
    await fs.mkdir(real);
    await fs.mkdir(env.agentDir, { recursive: true });
    await fs.symlink(real, join(env.agentDir, "skills"));
    await fs.symlink(real, join(temp, "linked-parent"));
    const result = await loadLocations(env, guard);
    expect(result.locations.find((location) => location.id === "user-pi")?.readOnlyReason).toContain("Symlink");
    expect(customLocation(join(temp, "linked-parent", "missing"), env).readOnlyReason).toContain("Symlink");
    await expect(previewRegistration(join(temp, "linked-parent", "missing"), "user", env, guard)).rejects.toThrow(
      "Symlink",
    );
  });

  it("never makes package caches or ancestor resource roots writable", async () => {
    const roots = [
      join(env.agentDir, "git", "host", "repo", "skills"),
      join(env.agentDir, "npm", "skills"),
      join(env.agentDir, "tmp", "extensions", "git-example", "skills"),
      join(temp, "node_modules", "example", "skills"),
      join(dirname(env.cwd), ".agents", "skills"),
      join(dirname(env.cwd), CONFIG_DIR_NAME, "skills"),
      join(dirname(env.cwd), CONFIG_DIR_NAME, "git", "host", "repo"),
    ];
    await put(userFile, { skills: roots });
    const result = await loadLocations(env, guard);
    expect(result.locations.slice(4)).toHaveLength(roots.length);
    expect(result.locations.slice(4).every((location) => !!location.readOnlyReason)).toBe(true);
    for (const root of roots) await expect(previewRegistration(root, "user", env, guard)).rejects.toThrow("read-only");
  });

  it("expands tilde, classifies current-project paths, and rejects unsafe containers", async () => {
    expect(customLocation(" ~/custom ", env).path).toBe(join(env.homeDir, "custom"));
    expect(customLocation("custom", env).scope).toBe("project");
    expect(customLocation(join(temp, "external"), env).scope).toBe("user");
    for (const input of ["/", "~", env.cwd, dirname(env.cwd), "", "*.md", "+path", "bad\u001bpath"]) {
      expect(() => customLocation(input, env)).toThrow();
    }
    const bundle = join(temp, "bundle");
    await put(join(bundle, "SKILL.md"), "bundle");
    expect(() => customLocation(bundle, env)).toThrow("bundle");
    const file = join(temp, "file");
    await put(file, {});
    expect(() => customLocation(file, env)).toThrow("directory");
  });
});

describe("native registration", () => {
  it.each(["!skills", "+skills", "-skills", "~", "~/skills"])(
    "keeps literal relative path %s distinct from native filters and home expansion",
    async (name) => {
      vi.stubEnv("HOME", env.homeDir);
      const root = join(env.cwd, CONFIG_DIR_NAME, name);
      await fs.mkdir(join(root, "sample"), { recursive: true });
      const file = join(root, "sample", "SKILL.md");
      await fs.writeFile(file, "---\nname: sample\ndescription: Literal path fixture\n---\n");
      const registration = await plan(root);
      expect(registration.storedPath.startsWith("./")).toBe(true);
      await applyRegistration(registration, env, guard);
      const loader = new DefaultResourceLoader({
        cwd: env.cwd,
        agentDir: env.agentDir,
        settingsManager: SettingsManager.create(env.cwd, env.agentDir, { projectTrusted: true }),
        noExtensions: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
      });
      await loader.reload();
      expect(loader.getSkills().skills.map((skill) => skill.filePath)).toContain(file);
      expect((await loadLocations(env, guard)).locations.map((location) => location.path)).toContain(root);
    },
  );
  it("keeps preview side-effect free and supports copy only", async () => {
    const root = join(env.cwd, "custom");
    const result = await plan(root);
    expect(result).toEqual({
      scope: "project",
      root,
      settingsPath: projectFile,
      storedPath: "./../custom",
      before: undefined,
    });
    expect(await previewRegistration(root, "none", env, guard)).toBeUndefined();
    expect(await fs.readdir(temp)).toEqual([]);
  });

  it("writes only the selected scope array and preserves filters and unknown fields", async () => {
    const user = { skills: ["user-original", "!user/**"], future: { nested: [1, 2] } };
    const project = {
      skills: ["project-original", "+included", "-excluded", "!hidden/**", "file://%"],
      future: { nested: true },
    };
    await put(userFile, user);
    await put(projectFile, project);
    const root = join(env.cwd, "new-container");
    await applyRegistration(await plan(root), env, guard);
    expect(await json(userFile)).toEqual(user);
    expect(await json(projectFile)).toEqual({ ...project, skills: [...project.skills, "./../new-container"] });
    const outside = join(temp, "external-container");
    const userPlan = await plan(outside, "user");
    expect(userPlan.storedPath).toBe(outside);
    await applyRegistration(userPlan, env, guard);
    expect(await json(userFile)).toEqual({ ...user, skills: [...user.skills, outside] });
    expect((await json(projectFile)).skills).not.toContain(outside);
  });

  it("uses an absolute project registration outside cwd and detects already registered concrete paths", async () => {
    const external = join(temp, "external");
    const result = await plan(external);
    expect(result.storedPath).toBe(external);
    await applyRegistration(result, env, guard);
    expect(await previewRegistration(external, "project", env, guard)).toBeUndefined();
    await put(userFile, { skills: ["~/custom"] });
    expect(await previewRegistration(join(env.homeDir, "custom"), "user", env, guard)).toBeUndefined();
    // An exact inclusion filter is not a configured concrete container.
    await put(projectFile, { skills: [`+${external}`] });
    expect(await previewRegistration(external, "project", env, guard)).toBeDefined();
  });

  it.each([
    "",
    "{",
    "null",
    "[]",
    "3",
    "true",
    '"text"',
    '{"skills":null}',
    '{"skills":{}}',
    '{"skills":{"customDirectories":["old"]}}',
    '{"skills":"text"}',
    '{"skills":[1]}',
    '{"skills":["ok",null]}',
  ])("warns on invalid native data and blocks overwrite: %s", async (content) => {
    await fs.mkdir(dirname(projectFile), { recursive: true });
    await fs.writeFile(projectFile, content);
    const result = await loadLocations(env, guard);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.locations).toHaveLength(4);
    await expect(previewRegistration(join(env.cwd, "new"), "project", env, guard)).rejects.toThrow();
    expect(await fs.readFile(projectFile, "utf8")).toBe(content);
  });

  it.each(["project", "user"] as const)(
    "does not expose document secrets in %s warnings or registration errors",
    async (scope) => {
      const root = join(temp, "outside");
      const original = await plan(root, scope);
      const secret = "sk_live_locations_SYNTHETIC_API_KEY";
      const malformed = `{"apiKey":"${secret}","skills":[}`;
      const path = scope === "project" ? projectFile : userFile;
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, malformed);
      const result = await loadLocations(env, guard);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.join(" ")).not.toContain(secret);
      for (const operation of [
        () => previewRegistration(root, scope, env, guard),
        () => applyRegistration({ ...original, before: malformed }, env, guard),
      ]) {
        const error = await operation().then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain(secret);
        expect((error as Error).message).toBe("Settings contain malformed JSON.");
      }
      expect(await fs.readFile(path, "utf8")).toBe(malformed);
    },
  );

  it("rejects invalid raw data even if the native manager supplies defaults", async () => {
    const manager = SettingsManager.inMemory({});
    vi.spyOn(SettingsManager, "create").mockReturnValue(manager);
    await put(userFile, { skills: {} });
    await expect(previewRegistration(join(temp, "new"), "user", env, guard)).rejects.toThrow("array");
    expect(await json(userFile)).toEqual({ skills: {} });
  });

  it("rejects changed, newly created, deleted and structurally invalid files since preview", async () => {
    const root = join(env.cwd, "new");
    const absent = await plan(root);
    await put(projectFile, { skills: ["external"] });
    await expect(applyRegistration(absent, env, guard)).rejects.toThrow("changed since preview");
    expect((await json(projectFile)).skills).toEqual(["external"]);
    const existing = await plan(root);
    await fs.rm(projectFile);
    await expect(applyRegistration(existing, env, guard)).rejects.toThrow("changed since preview");
    const missingPlan = await plan(root);
    await fs.writeFile(projectFile, '{"skills":false}');
    await expect(applyRegistration(missingPlan, env, guard)).rejects.toThrow("changed since preview");
    const forged = { ...missingPlan, before: '{"skills":false}' };
    await expect(applyRegistration(forged, env, guard)).rejects.toThrow("array");
    expect(await fs.readFile(projectFile, "utf8")).toBe('{"skills":false}');
  });

  it("rejects a root replaced by a symlink after preview", async () => {
    const root = join(env.cwd, "custom");
    const result = await plan(root);
    await fs.mkdir(env.cwd, { recursive: true });
    await fs.mkdir(join(temp, "elsewhere"));
    await fs.symlink(join(temp, "elsewhere"), root);
    await expect(applyRegistration(result, env, guard)).rejects.toThrow("Symlink");
    expect(existsSync(projectFile)).toBe(false);
  });

  it("serializes full same-file mutations and rejects a stale second append without losing entries", async () => {
    await put(projectFile, { skills: ["original"] });
    const first = await plan(join(env.cwd, "first"));
    const second = await plan(join(env.cwd, "second"));
    const results = await Promise.allSettled([
      applyRegistration(first, env, guard),
      applyRegistration(second, env, guard),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await json(projectFile)).skills).toEqual(["original", "./../first"]);
    await applyRegistration(await plan(join(env.cwd, "second")), env, guard);
    expect((await json(projectFile)).skills).toEqual(["original", "./../first", "./../second"]);
  });

  it("coordinates load and preview reads with a pending native-file mutation", async () => {
    await put(projectFile, { skills: ["old"] });
    const ready = deferred();
    const release = deferred();
    const writing = withFileMutationQueue(projectFile, async () => {
      ready.resolve();
      await release.promise;
      await put(projectFile, { skills: ["new"] });
    });
    await ready.promise;
    const loading = loadLocations(env, guard);
    const previewing = plan(join(env.cwd, "container"));
    release.resolve();
    await writing;
    expect((await loading).locations.map((location) => location.path)).toContain(join(env.cwd, CONFIG_DIR_NAME, "new"));
    expect((await previewing).before).toBe(JSON.stringify({ skills: ["new"] }));
  });

  it.each(["trust", "ownership"] as const)("rechecks %s after waiting for the mutation queue", async (kind) => {
    const result = await plan(join(env.cwd, "custom"));
    const ready = deferred();
    const release = deferred();
    const blocking = withFileMutationQueue(projectFile, async () => {
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const applying = applyRegistration(result, env, guard);
    if (kind === "trust") trusted = false;
    else owned = false;
    release.resolve();
    await blocking;
    await expect(applying).rejects.toThrow(kind === "trust" ? "trust" : "Owner");
    expect(existsSync(projectFile)).toBe(false);
  });

  it("rechecks project trust after the raw read and before native publication", async () => {
    const result = await plan(join(env.cwd, "custom"));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.readFile).mockImplementationOnce(async (...args: Parameters<typeof fs.readFile>) => {
      try {
        return await actual.readFile(...args);
      } finally {
        trusted = false;
      }
    });
    await expect(applyRegistration(result, env, guard)).rejects.toThrow("trust");
    expect(existsSync(projectFile)).toBe(false);
  });

  it.each(["load", "preview"] as const)(
    "does not return stale project data when trust is revoked during %s",
    async (operation) => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(fs.readFile).mockImplementationOnce(async (...args: Parameters<typeof fs.readFile>) => {
        try {
          return await actual.readFile(...args);
        } finally {
          trusted = false;
        }
      });
      await expect(
        operation === "load"
          ? loadLocations(env, guard)
          : previewRegistration(join(env.cwd, "custom"), "project", env, guard),
      ).rejects.toThrow("trust");
      expect(await fs.readdir(temp)).toEqual([]);
    },
  );

  it("requires project trust for a project-contained root even in user registration scope", async () => {
    trusted = false;
    await expect(previewRegistration(join(env.cwd, "custom"), "user", env, guard)).rejects.toThrow("trust");
    expect(existsSync(userFile)).toBe(false);
    await applyRegistration(await plan(join(temp, "outside"), "user"), env, guard);
    expect((await json(userFile)).skills).toEqual([join(temp, "outside")]);
  });

  it("retains native initial storage errors rather than treating substituted defaults as success", async () => {
    const failure = new Error("Native initial read failed");
    const manager = SettingsManager.fromStorage(
      {
        withLock: () => {
          throw failure;
        },
      },
      { projectTrusted: true },
    );
    vi.spyOn(SettingsManager, "create").mockReturnValue(manager);
    await expect(previewRegistration(join(temp, "outside"), "user", env, guard)).rejects.toMatchObject({
      message: "Cannot read user settings.",
      cause: failure,
    });
    expect(existsSync(userFile)).toBe(false);
  });

  it("throws the retained native persistence error after flush and leaves the queue usable", async () => {
    await put(userFile, { skills: ["original"], future: 1 });
    const result = await plan(join(temp, "outside"), "user");
    const failure = new Error("Native write failed: sk_live_SYNTHETIC_SECRET");
    const manager = SettingsManager.fromStorage(
      {
        withLock: (scope, fn) => {
          const next = fn(scope === "global" ? JSON.stringify({ skills: ["original"], future: 1 }) : undefined);
          if (next !== undefined) throw failure;
        },
      },
      { projectTrusted: true },
    );
    const create = vi.spyOn(SettingsManager, "create").mockReturnValueOnce(manager);
    const reload = vi.spyOn(manager, "reload");
    await expect(applyRegistration(result, env, guard)).rejects.toMatchObject({
      message: "Cannot save user settings.",
      cause: failure,
    });
    expect(reload).not.toHaveBeenCalled();
    expect(await json(userFile)).toEqual({ skills: ["original"], future: 1 });
    create.mockRestore();
    await applyRegistration(result, env, guard);
    expect(await json(userFile)).toEqual({ skills: ["original", join(temp, "outside")], future: 1 });
  });

  it("does not claim that cancellation after flush rolled back native persistence", async () => {
    const controller = new AbortController();
    guard = {
      ...guard,
      signal: controller.signal,
      check() {
        controller.signal.throwIfAborted();
      },
    };
    const result = await plan(join(temp, "outside"), "user");
    const flush = SettingsManager.prototype.flush;
    vi.spyOn(SettingsManager.prototype, "flush").mockImplementationOnce(async function (this: SettingsManager) {
      await flush.call(this);
      controller.abort();
    });
    await expect(applyRegistration(result, env, guard)).rejects.toThrow();
    expect((await json(userFile)).skills).toEqual([result.storedPath]);
  });
  it("rejects forged destinations from another environment", async () => {
    const result = await plan(join(env.cwd, "custom"));
    await expect(
      applyRegistration({ ...result, settingsPath: resolve(temp, "other.json") }, env, guard),
    ).rejects.toThrow("target changed");
    expect(await fs.readdir(temp)).toEqual([]);
  });
});
