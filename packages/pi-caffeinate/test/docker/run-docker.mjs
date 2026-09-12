import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dockerDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(dockerDirectory, "../..");
const image = `pi-caffeinate-dbus-smoke:${process.pid}`;

const version = spawnSync("docker", ["--version"], { encoding: "utf8" });
if (version.error || version.status !== 0) {
  throw new Error("Docker is required for the pi-caffeinate D-Bus smoke.");
}

let built = false;
try {
  runDocker(["build", "--file", path.join(dockerDirectory, "Dockerfile"), "--tag", image, packageDirectory]);
  built = true;
  runDocker(["run", "--rm", image]);
} finally {
  if (built) {
    spawnSync("docker", ["image", "rm", image], { encoding: "utf8", timeout: 60_000 });
  }
}

function runDocker(args) {
  const result = spawnSync("docker", args, {
    cwd: packageDirectory,
    stdio: "inherit",
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
