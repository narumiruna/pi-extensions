import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { type ExtensionAPI, parseArgs } from "@earendil-works/pi-coding-agent";

const ENV_FILE_FLAG = "env-file";
const ENV_FILE_OPTION = `--${ENV_FILE_FLAG}`;

export function resolveEnvFileArgument(args: readonly string[]): string | undefined {
  const value = parseArgs([...args]).unknownFlags.get(ENV_FILE_FLAG);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${ENV_FILE_OPTION} requires a path`);
  }
  return value;
}

export function loadEnvFile(
  path: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
  const filePath = resolve(options.cwd ?? process.cwd(), path);
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Could not read the file passed to ${ENV_FILE_OPTION}`);
  }

  const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const parsed = Object.fromEntries(
    Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const env = options.env ?? process.env;
  for (const [name, value] of Object.entries(parsed)) {
    if (env[name] === undefined) env[name] = value;
  }
  return parsed;
}

export default function registerDotenvExtension(pi: ExtensionAPI): void {
  pi.registerFlag(ENV_FILE_FLAG, {
    description: "Load missing environment variables from a dotenv file",
    type: "string",
  });

  const path = resolveEnvFileArgument(process.argv.slice(2));
  if (path !== undefined) loadEnvFile(path);
}
