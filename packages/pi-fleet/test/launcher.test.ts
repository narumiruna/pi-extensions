import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { createPiLauncher } from "../src/launcher.js";

const execFileAsync = promisify(execFile);

test("launcher quotes paths and arguments, stays private, excludes secrets, and cleans once", async () => {
  const directory = await mkdtemp("/tmp/pi-fleet-launcher-test-");
  try {
    const launcher = await createPiLauncher(
      {
        command: "/runtime path/it's-node",
        args: ["/package path/cli.js", "--name", "child's name"],
      },
      directory,
    );
    const source = await readFile(launcher.path, "utf8");
    assert.match(source, /^#!\/bin\/sh\n/u);
    assert.match(source, /exec '\/runtime path\/it'"'"'s-node'/u);
    assert.match(source, /'child'"'"'s name'/u);
    assert.doesNotMatch(source, /pifleet:v1|PI_FLEET_INVITE|secret/u);
    assert.equal((await stat(launcher.path)).mode & 0o777, 0o700);
    assert.equal(launcher.command, launcher.path);
    await launcher.cleanup();
    await launcher.cleanup();
    await assert.rejects(access(launcher.path));
    assert.equal(join(directory, "."), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("embedded launch environments stay in a private self-deleting launcher", async () => {
  const directory = await mkdtemp("/tmp/pi-fleet-launcher-environment-test-");
  try {
    const output = join(directory, "child-environment.txt");
    const invite = "pifleet:v1:secret-placeholder";
    const launcher = await createPiLauncher(
      {
        command: process.execPath,
        args: ["-e", 'require("node:fs").writeFileSync(process.argv[1], process.env.PI_FLEET_INVITE ?? "")', output],
      },
      directory,
      { PI_FLEET_INVITE: invite },
    );
    const source = await readFile(launcher.path, "utf8");
    assert.match(source, /rm -f/u);
    assert.match(source, /export PI_FLEET_INVITE=/u);
    assert.equal(source.indexOf("rm -f") < source.indexOf("export PI_FLEET_INVITE="), true);
    assert.equal((await stat(launcher.path)).mode & 0o777, 0o700);
    await execFileAsync(launcher.command);
    await assert.rejects(access(launcher.path));
    assert.equal(await readFile(output, "utf8"), invite);
    await launcher.cleanup();

    await assert.rejects(
      createPiLauncher({ command: "/bin/true", args: [] }, directory, { "bad-key": "value" }),
      /launch environment is invalid/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
