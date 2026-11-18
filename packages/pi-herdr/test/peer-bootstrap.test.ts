import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";

const exec = promisify(execFile);
const skillPath = resolve("packages/pi-herdr/skills/pi-herdr/SKILL.md");
const shell = "/bin/bash";

// Only trusted test code runs. The preload target does not exist; no hook or checkout candidate is executed.
for (const substitution of [false, true]) {
  test.skipIf(process.platform === "win32")(
    `Node bootstrap clears late preload settings, substitution=${substitution}`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "pi-peer-bootstrap-"));
      try {
        const probe = join(directory, "environment.mjs");
        await writeFile(
          probe,
          "console.log(JSON.stringify({ options: process.env.NODE_OPTIONS, path: process.env.NODE_PATH }));\n",
        );
        const command = substitution
          ? 'value=$(NODE_OPTIONS= NODE_PATH= "$1" "$2") || exit 1; printf "%s" "$value"'
          : 'NODE_OPTIONS= NODE_PATH= "$1" "$2"';
        const result = await exec(shell, ["--noprofile", "--norc", "-c", command, "--", process.execPath, probe], {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: directory,
            TMPDIR: directory,
            NODE_OPTIONS: "--import=file:///nonexistent-pi-preload-cannot-run.mjs",
            NODE_PATH: join(directory, "nonexistent-modules"),
          },
          timeout: 1000,
          maxBuffer: 4096,
        });
        assert.deepEqual(JSON.parse(result.stdout), { options: "", path: "" });
        assert.equal(result.stderr, "");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test("all documented Node helper calls clear preload settings before startup", async () => {
  const skill = await readFile(skillPath, "utf8");
  const blocks = [...skill.matchAll(/```bash\n([\s\S]*?)\n```/gu)].map((match) => match[1] ?? "");
  const calls = blocks.flatMap((block) => block.split("\n").filter((line) => line.includes('"$node_path"')));
  assert.ok(calls.length > 0);
  for (const line of calls) assert.ok(line.includes('NODE_OPTIONS= NODE_PATH= "$node_path"'), line);
  assert.ok(calls.some((line) => line.startsWith("herdr_path=$(NODE_OPTIONS=")));
  assert.ok(calls.some((line) => line.includes("spawn-hc-peer.mjs")));
  assert.ok(calls.some((line) => line.includes('spawn-peer.mjs" --name')));
});

test.skipIf(process.platform === "win32")(
  "the hc template example passes apostrophes and shell signs as one task argument",
  async () => {
    const skill = await readFile(skillPath, "utf8");
    assert.match(skill, /--name reviewer reviewer "\$\(< \/absolute\/task\.txt\)"/u);
    const directory = await mkdtemp(join(tmpdir(), "pi-peer-task-"));
    try {
      const taskFile = join(directory, "task.txt");
      const task =
        'Review the user\'s changes. Keep $HOME, $(not-a-command), `literal`, and "quotes" as data.\nSecond line.';
      await writeFile(taskFile, task);
      const fakeHc = join(directory, "trusted-hc");
      await writeFile(fakeHc, '#!/bin/sh\nprintf "%s\\000" "$@"\n', { mode: 0o700 });
      const command =
        'HC_SOCKET="$3" "$1" run --json --bg --outlive-parent --parent t1 --name reviewer reviewer "$(< "$2")"';
      const result = await exec(shell, ["--noprofile", "--norc", "-c", command, "--", fakeHc, taskFile, "/unused"], {
        env: { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory },
        timeout: 1000,
        maxBuffer: 4096,
      });
      const args = result.stdout.split("\0");
      assert.equal(args.pop(), "");
      assert.deepEqual(args, [
        "run",
        "--json",
        "--bg",
        "--outlive-parent",
        "--parent",
        "t1",
        "--name",
        "reviewer",
        "reviewer",
        task,
      ]);
      assert.equal(result.stderr, "");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
