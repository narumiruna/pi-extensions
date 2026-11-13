import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { BrowserCandidate, BrowserCandidateDefinition } from "./runtime.js";
import type { EffectiveBrowserSettings } from "./settings.js";

function normalizePathForComparison(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function browserCandidateDefinitions(browser: EffectiveBrowserSettings): BrowserCandidateDefinition[] {
  const explicitCandidate = explicitBrowserCandidateDefinition(browser);
  if (explicitCandidate.length > 0) return explicitCandidate;

  return uniqueBrowserCandidates(platformBrowserCandidateDefinitions());
}

function explicitBrowserCandidateDefinition(browser: EffectiveBrowserSettings): BrowserCandidateDefinition[] {
  if (!browser.executablePath) return [];
  return [
    {
      label: browser.executablePathSource === "environment" ? "PI_CHROME_DEVTOOLS_BROWSER" : "browser.executablePath",
      executable: browser.executablePath,
      source: "env",
    },
  ];
}

function platformBrowserCandidateDefinitions(): BrowserCandidateDefinition[] {
  if (process.platform === "darwin") {
    return [
      {
        label: "Google Chrome",
        executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        source: "wellKnownPath",
      },
      {
        label: "Chromium",
        executable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        source: "wellKnownPath",
      },
      {
        label: "Brave Browser",
        executable: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        source: "wellKnownPath",
      },
      {
        label: "Microsoft Edge",
        executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        source: "wellKnownPath",
      },
    ];
  }

  if (process.platform === "win32") {
    return windowsBrowserCandidateDefinitions();
  }

  return [
    { label: "Google Chrome", executable: "google-chrome", source: "path" },
    { label: "Google Chrome Stable", executable: "google-chrome-stable", source: "path" },
    { label: "Chromium", executable: "chromium", source: "path" },
    { label: "Chromium Browser", executable: "chromium-browser", source: "path" },
    { label: "Brave Browser", executable: "brave-browser", source: "path" },
    { label: "Brave", executable: "brave", source: "path" },
    { label: "Microsoft Edge", executable: "microsoft-edge", source: "path" },
    { label: "Microsoft Edge Stable", executable: "microsoft-edge-stable", source: "path" },
  ];
}

function windowsBrowserCandidateDefinitions(): BrowserCandidateDefinition[] {
  const programFiles = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const wellKnownPaths = programFiles.flatMap((root) => [
    join(root, "Google", "Chrome", "Application", "chrome.exe"),
    join(root, "Chromium", "Application", "chrome.exe"),
    join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]);
  return [
    ...wellKnownPaths.map((executable) => ({
      label: browserLabelFromExecutable(executable),
      executable,
      source: "wellKnownPath" as const,
    })),
    { label: "Google Chrome", executable: "chrome.exe", source: "path" },
    { label: "Chromium", executable: "chromium.exe", source: "path" },
    { label: "Brave Browser", executable: "brave.exe", source: "path" },
    { label: "Microsoft Edge", executable: "msedge.exe", source: "path" },
  ];
}

function browserLabelFromExecutable(executable: string) {
  const normalizedExecutable = normalizePathForComparison(executable);
  if (normalizedExecutable.includes("brave")) return "Brave Browser";
  if (normalizedExecutable.includes("edge") || normalizedExecutable.includes("msedge")) {
    return "Microsoft Edge";
  }
  if (normalizedExecutable.includes("chromium")) return "Chromium";
  return "Google Chrome";
}

function uniqueBrowserCandidates(candidates: BrowserCandidateDefinition[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = normalizePathForComparison(candidate.executable);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function resolveBrowserCandidates(
  definitions: BrowserCandidateDefinition[],
  access: (path: string, mode: number) => Promise<void>,
  throwIfCancelled: () => void,
) {
  const candidates: BrowserCandidate[] = [];
  for (const definition of definitions) {
    const resolvedExecutable = await resolveBrowserExecutable(definition.executable, access, throwIfCancelled);
    throwIfCancelled();
    if (!resolvedExecutable) continue;
    candidates.push({ ...definition, resolvedExecutable });
  }
  return uniqueBrowserCandidatesByResolvedPath(candidates);
}

function uniqueBrowserCandidatesByResolvedPath(candidates: BrowserCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = normalizePathForComparison(resolve(candidate.resolvedExecutable));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveBrowserExecutable(
  executable: string,
  access: (path: string, mode: number) => Promise<void>,
  throwIfCancelled: () => void,
) {
  if (hasPathSeparator(executable) || isAbsolute(executable)) {
    const resolvedExecutable = isAbsolute(executable) ? executable : resolve(executable);
    return (await canAccessExecutable(resolvedExecutable, access, throwIfCancelled)) ? resolvedExecutable : undefined;
  }

  for (const directory of executableSearchPath()) {
    for (const executableName of executableSearchNames(executable)) {
      const candidate = join(directory, executableName);
      if (await canAccessExecutable(candidate, access, throwIfCancelled)) return candidate;
    }
  }
  return undefined;
}

function hasPathSeparator(path: string) {
  return path.includes("/") || path.includes("\\");
}

function executableSearchPath() {
  return (process.env.PATH ?? "").split(delimiter).filter((part) => part.length > 0);
}

function executableSearchNames(executable: string) {
  if (process.platform !== "win32" || /\.[a-z0-9]+$/i.test(executable)) return [executable];
  return [executable, `${executable}.exe`, `${executable}.cmd`, `${executable}.bat`];
}

async function canAccessExecutable(
  path: string,
  access: (path: string, mode: number) => Promise<void>,
  throwIfCancelled: () => void,
) {
  let accessible = false;
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    accessible = true;
  } catch {
    // An absent or inaccessible executable is not a browser candidate.
  }
  throwIfCancelled();
  return accessible;
}
