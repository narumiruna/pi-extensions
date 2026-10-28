import { lstatSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, SettingsManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Environment, Guard, Location, RegistrationPlan, RegistrationScope } from "./types.ts";

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function check(env: Environment, guard: Guard, project = false): void {
  guard.signal.throwIfAborted();
  guard.check();
  if (project && (!env.isProjectTrusted() || !guard.isProjectTrusted())) {
    throw new Error("Project trust is required for this location.");
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function pathFrom(input: string, base: string, env: Environment): string {
  let path = input.trim();
  if (!path || Array.from(path).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error("Enter a concrete directory path.");
  }
  if (path === "~") path = env.homeDir;
  else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    path = join(env.homeDir, path.slice(2));
  } else if (path.startsWith("file://")) path = fileURLToPath(path);
  return resolve(base, path);
}

// Pi classifies !/+/- prefixes and */? before path normalization. Braces and brackets are
// also excluded here: this manager accepts concrete containers, never glob-like input.
function concrete(entry: string): boolean {
  return entry.trim().length > 0 && !/^[!+-]/.test(entry) && !/[*?[\]{}]/.test(entry);
}

function protectedReason(root: string, env: Environment): string | undefined {
  if (root.split(sep).some((part) => part === "node_modules" || part === ".git")) {
    return "Package and Git directories are read-only.";
  }
  for (const base of [resolve(env.agentDir), join(resolve(env.cwd), CONFIG_DIR_NAME)]) {
    if (["git", "npm", join("tmp", "extensions")].some((part) => within(join(base, part), root))) {
      return "Pi package caches are read-only.";
    }
  }
  for (let parent = dirname(resolve(env.cwd)); ; parent = dirname(parent)) {
    if (
      [join(parent, ".agents", "skills"), join(parent, CONFIG_DIR_NAME, "skills")].some((path) => within(path, root))
    ) {
      // The user shared root remains a supported destination even when home is an ancestor.
      if (!within(join(resolve(env.homeDir), ".agents", "skills"), root)) {
        return "Ancestor project skill locations are read-only.";
      }
    }
    if (["git", "npm", join("tmp", "extensions")].some((part) => within(join(parent, CONFIG_DIR_NAME, part), root))) {
      return "Pi package caches are read-only.";
    }
    if (dirname(parent) === parent) break;
  }
  return undefined;
}

function rootReason(root: string, env: Environment): string | undefined {
  // Check every existing component, including a linked parent of a missing container.
  for (let path = root; ; path = dirname(path)) {
    const info = stat(path);
    if (info?.isSymbolicLink()) return "Symlinked locations are read-only.";
    if (info && !info.isDirectory()) return "The location is not a directory.";
    if (dirname(path) === path) break;
  }
  if (stat(join(root, "SKILL.md"))) return "A skill bundle cannot be used as a container.";
  return protectedReason(root, env);
}

export function customLocation(input: string, env: Environment): Location {
  if (!concrete(input.trim())) throw new Error("Enter a concrete directory path, not a filter or glob.");
  const path = pathFrom(input, env.cwd, env);
  if (path === parse(path).root || path === resolve(env.homeDir) || within(path, env.cwd)) {
    throw new Error("A filesystem root, home directory, or workspace ancestor cannot be a skill container.");
  }
  const readOnlyReason = rootReason(path, env);
  if (
    readOnlyReason === "The location is not a directory." ||
    readOnlyReason === "A skill bundle cannot be used as a container."
  ) {
    throw new Error(readOnlyReason);
  }
  const scope = within(env.cwd, path) ? "project" : "user";
  return {
    id: `custom:${path}`,
    label: "Custom directory",
    path,
    scope,
    readOnlyReason:
      readOnlyReason ?? (scope === "project" && !env.isProjectTrusted() ? "Project trust is required." : undefined),
  };
}

function queueIdentity(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (missing(error) || (error instanceof Error && "code" in error && error.code === "ENOTDIR")) return resolve(path);
    throw error;
  }
}

function settingsPath(scope: "project" | "user", env: Environment): string {
  return scope === "project"
    ? join(resolve(env.cwd), CONFIG_DIR_NAME, "settings.json")
    : join(resolve(env.agentDir), "settings.json");
}

async function snapshot(path: string, env: Environment, guard: Guard, project: boolean): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    check(env, guard, project);
    return content;
  } catch (error) {
    check(env, guard, project);
    if (missing(error)) return undefined;
    throw error;
  }
}

function skillsFromDocument(content: string | undefined): string[] {
  if (content === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch (error) {
    // Node's parser message can include the document, including unrelated credentials.
    throw new Error("Settings contain malformed JSON.", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Settings must contain a JSON object.");
  }
  const skills = (value as Record<string, unknown>).skills;
  if (skills === undefined) return [];
  if (!Array.isArray(skills) || !skills.every((entry) => typeof entry === "string")) {
    throw new Error("Settings skills must be an array of strings.");
  }
  return skills;
}

function scopedSkills(manager: SettingsManager, scope: "project" | "user"): string[] {
  const value = scope === "project" ? manager.getProjectSettings().skills : manager.getGlobalSettings().skills;
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Native settings skills must be an array of strings.");
  }
  return value;
}

function nativeErrors(manager: SettingsManager, scope?: "project" | "user", action = "read"): Error[] {
  return manager
    .drainErrors()
    .filter((entry) => !scope || entry.scope === (scope === "user" ? "global" : "project"))
    .map(
      (entry) =>
        new Error(
          `Cannot ${action} ${entry.scope === "global" ? "user" : "project"} settings${entry.path ? ` at ${entry.path}` : ""}.`,
          { cause: entry.error },
        ),
    );
}

function assertNative(manager: SettingsManager, scope: "project" | "user"): void {
  const errors = nativeErrors(manager, scope);
  if (errors.length) throw errors[0];
}

export async function loadLocations(
  env: Environment,
  guard: Guard,
): Promise<{ locations: Location[]; warnings: string[] }> {
  check(env, guard);
  const trusted = env.isProjectTrusted() && guard.isProjectTrusted();
  const locations: Location[] = [
    {
      id: "project-pi",
      label: "Project (Pi)",
      path: join(resolve(env.cwd), CONFIG_DIR_NAME, "skills"),
      scope: "project",
    },
    { id: "user-pi", label: "User (Pi)", path: join(resolve(env.agentDir), "skills"), scope: "user" },
    {
      id: "project-shared",
      label: "Project (Shared)",
      path: join(resolve(env.cwd), ".agents", "skills"),
      scope: "project",
    },
    { id: "user-shared", label: "User (Shared)", path: join(resolve(env.homeDir), ".agents", "skills"), scope: "user" },
  ];
  const warnings: string[] = [];
  for (const location of locations) {
    try {
      location.readOnlyReason =
        rootReason(location.path, env) ??
        (location.scope === "project" && !trusted ? "Project trust is required." : undefined);
    } catch (error) {
      location.readOnlyReason = String(error);
    }
  }
  const read = async () => {
    check(env, guard, trusted);
    const manager = SettingsManager.create(env.cwd, env.agentDir, {
      projectTrusted: env.isProjectTrusted() && guard.isProjectTrusted(),
    });
    warnings.push(...nativeErrors(manager).map((error) => error.message));
    const seen = new Set(locations.map((location) => location.path));
    for (const scope of trusted ? (["user", "project"] as const) : (["user"] as const)) {
      const path = settingsPath(scope, env);
      let entries: string[];
      try {
        const raw = await snapshot(path, env, guard, trusted);
        check(env, guard, trusted);
        skillsFromDocument(raw); // Reject invalid raw data even if Pi migrated it or substituted defaults.
        entries = scopedSkills(manager, scope);
      } catch (error) {
        check(env, guard, trusted);
        warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const entry of entries) {
        if (!concrete(entry)) continue;
        try {
          const resolved = pathFrom(entry, dirname(path), env);
          const location = customLocation(resolved, env);
          if (!seen.has(location.path)) {
            seen.add(location.path);
            locations.push(location);
          }
        } catch {
          // Native entries can be standalone files or unsafe containers, neither is a target.
        }
      }
    }
    check(env, guard, trusted);
  };
  // Use the same order for both read locks. Missing paths remain absent; native reads can
  // acquire a transient native lock for existing files. These queues are process-local.
  await withFileMutationQueue(settingsPath("user", env), async () => {
    check(env, guard, trusted);
    if (trusted && queueIdentity(settingsPath("user", env)) !== queueIdentity(settingsPath("project", env))) {
      await withFileMutationQueue(settingsPath("project", env), read);
      check(env, guard, trusted);
    } else {
      await read();
      check(env, guard, trusted);
    }
  });
  check(env, guard, trusted);
  return { locations, warnings };
}

function registrationTarget(
  root: string,
  scope: "project" | "user",
  env: Environment,
  guard: Guard,
): { root: string; project: boolean; storedPath: string } {
  check(env, guard);
  const location = customLocation(root, env);
  const project = scope === "project" || location.scope === "project";
  check(env, guard, project);
  if (location.readOnlyReason) throw new Error(location.readOnlyReason);
  const storedPath =
    scope === "project" && within(env.cwd, location.path)
      ? `.${sep}${relative(join(resolve(env.cwd), CONFIG_DIR_NAME), location.path)}`
      : location.path;
  return { root: location.path, project, storedPath };
}

export async function previewRegistration(
  root: string,
  scope: RegistrationScope,
  env: Environment,
  guard: Guard,
): Promise<RegistrationPlan | undefined> {
  check(env, guard);
  if (scope === "none") return undefined;
  const target = registrationTarget(root, scope, env, guard);
  const path = settingsPath(scope, env);
  const plan = await withFileMutationQueue(path, async () => {
    check(env, guard, target.project);
    const before = await snapshot(path, env, guard, target.project);
    check(env, guard, target.project);
    skillsFromDocument(before);
    const manager = SettingsManager.create(env.cwd, env.agentDir, {
      projectTrusted: env.isProjectTrusted() && guard.isProjectTrusted(),
    });
    assertNative(manager, scope);
    const entries = scopedSkills(manager, scope);
    if (
      entries.some((entry) => {
        if (!concrete(entry)) return false;
        try {
          return pathFrom(entry, dirname(path), env) === target.root;
        } catch {
          return false; // Preserve entries this manager cannot interpret, without using them as roots.
        }
      })
    )
      return undefined;
    return { scope, root: target.root, settingsPath: path, storedPath: target.storedPath, before };
  });
  check(env, guard, target.project);
  return plan;
}

export async function applyRegistration(plan: RegistrationPlan, env: Environment, guard: Guard): Promise<void> {
  const target = registrationTarget(plan.root, plan.scope, env, guard);
  const path = settingsPath(plan.scope, env);
  if (path !== plan.settingsPath || target.storedPath !== plan.storedPath)
    throw new Error("Registration target changed since preview.");
  await withFileMutationQueue(path, async () => {
    check(env, guard, target.project);
    const latest = await snapshot(path, env, guard, target.project);
    check(env, guard, target.project);
    if (latest !== plan.before) throw new Error("Settings changed since preview; review registration again.");
    skillsFromDocument(latest);
    const manager = SettingsManager.create(env.cwd, env.agentDir, {
      projectTrusted: env.isProjectTrusted() && guard.isProjectTrusted(),
    });
    assertNative(manager, plan.scope);
    const entries = scopedSkills(manager, plan.scope);
    registrationTarget(plan.root, plan.scope, env, guard);
    const next = [...entries, plan.storedPath];
    if (plan.scope === "project") manager.setProjectSkillPaths(next);
    else manager.setSkillPaths(next);
    // Native setters queue persistence. Flush alone does not report storage failure.
    await manager.flush();
    const errors = nativeErrors(manager, plan.scope, "save");
    check(env, guard, target.project);
    if (errors.length) throw errors[0];
  });
  check(env, guard, target.project);
}
