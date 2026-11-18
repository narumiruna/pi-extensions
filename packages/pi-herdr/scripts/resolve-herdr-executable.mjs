import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Resolve without executing checkout-controlled candidates or Windows' implicit cwd lookup. */
export async function resolveHerdrExecutable({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
} = {}) {
  let directory = await realpath(cwd);
  let project = directory;
  while (true) {
    try {
      await stat(resolve(directory, ".git"));
      project = directory;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const pathValue = platform === "win32" ? (env.PATH ?? env.Path ?? env.path) : env.PATH;
  for (const entry of (pathValue ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!isAbsolute(entry)) continue;
    try {
      const candidate = await realpath(resolve(entry, platform === "win32" ? "herdr.exe" : "herdr"));
      const local = relative(project, candidate);
      if (local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local))) continue;
      if (controls.test(candidate) || !(await stat(candidate)).isFile()) continue;
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(error.code)) throw error;
    }
  }
  throw new Error(
    `No trusted absolute Herdr executable outside the project ${displayText(project, 512)} was found on PATH`,
  );
}

function displayText(value, limit) {
  return [
    ...stripVTControlCharacters(value)
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
      .trim(),
  ]
    .slice(0, limit)
    .join("");
}
