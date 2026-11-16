import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const piCommand = process.platform === "win32" ? "pi.cmd" : "pi";
const unscopedNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function run(command, args, options = {}) {
  const { allowFailure = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, { stdio: "inherit", ...spawnOptions });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0 && !allowFailure) {
    process.exit(result.status ?? 1);
  }
  return result.status === 0;
}

function requireArgument(value, usage) {
  if (!value) {
    console.error(`Usage: ${usage}`);
    process.exit(2);
  }
}

function requireUnscopedName(name) {
  requireArgument(name, "npm run package:pack -- <unscoped-name>");
  if (!unscopedNamePattern.test(name)) {
    console.error(`invalid package name: ${name}`);
    process.exit(2);
  }
}

function doctor(packageName) {
  requireArgument(packageName, "npm run package:doctor -- <package>");
  console.log(`package: ${packageName}`);
  run(npmCommand, ["whoami"], { allowFailure: true });
  run(npmCommand, ["config", "get", "registry"]);
  run(npmCommand, ["access", "get", "status", packageName], { allowFailure: true });
  run(npmCommand, ["dist-tag", "ls", packageName], { allowFailure: true });
  run(npmCommand, ["view", packageName, "version"], { allowFailure: true });
}

function doctorAll() {
  const packageNames = readdirSync("packages", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("packages", entry.name, "package.json"))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, "utf8")).name)
    .filter((name) => typeof name === "string")
    .sort();
  for (const packageName of packageNames) {
    doctor(packageName);
  }
}

function makePublic(packageName) {
  requireArgument(packageName, "npm run package:public -- <package>");
  run(npmCommand, ["access", "set", "status=public", packageName]);
  run(npmCommand, ["view", packageName, "version"]);
}

function resolveWorkspace(name) {
  requireUnscopedName(name);
  for (const directory of [`packages/${name}`, `packages/pi-${name}`]) {
    const manifest = join(directory, "package.json");
    if (!existsSync(manifest)) continue;
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    if (value.name !== name && value.name !== `@narumitw/${name}` && value.name !== `@narumitw/pi-${name}`) continue;
    return { name: value.name, directory, service: !value.pi?.extensions?.length && Boolean(value.bin) };
  }
  console.error(`No matching workspace: ${name}`);
  process.exit(2);
}

function pack(name) {
  const workspace = resolveWorkspace(name);
  run(npmCommand, ["--workspace", workspace.name, "pack", "--dry-run"]);
}

function install(name) {
  requireArgument(name, "npm run package:install -- <unscoped-name>");
  if (!unscopedNamePattern.test(name)) {
    console.error(`invalid package name: ${name}`);
    process.exit(2);
  }
  const workspace = resolveWorkspace(name);
  const packageName = workspace.name;
  const isPublished = run(npmCommand, ["view", packageName, "version"], {
    allowFailure: true,
    stdio: "ignore",
  });
  if (workspace.service) {
    if (!isPublished) run(npmCommand, ["--workspace", packageName, "run", "build"]);
    run(npmCommand, ["install", "--global", isPublished ? packageName : `./${workspace.directory}`]);
  } else if (isPublished) {
    run(piCommand, ["install", `npm:${packageName}`]);
  } else {
    run(piCommand, ["install", `./${workspace.directory}`]);
  }
}

function printUsage() {
  console.log(`Usage: node scripts/run-package-workflow.mjs <command> [argument]

Commands:
  doctor <package>
  doctor-all
  public <package>
  pack <unscoped-name>
  install <unscoped-name>`);
}

const [command, argument, ...extraArguments] = process.argv.slice(2);
if (extraArguments.length > 0 || (command === "doctor-all" && argument)) {
  printUsage();
  process.exit(2);
}
if (command === "--help" || command === "-h") {
  printUsage();
} else if (command === "doctor") {
  doctor(argument);
} else if (command === "doctor-all") {
  doctorAll();
} else if (command === "public") {
  makePublic(argument);
} else if (command === "pack") {
  pack(argument);
} else if (command === "install") {
  install(argument);
} else {
  printUsage();
  process.exit(2);
}
