import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";

const launcherUrl = pathToFileURL(path.resolve("packages/pi-tui-kit/scripts/showcase.mjs")).href;
const { runShowcase } = await import(launcherUrl);

test("showcase launcher builds Kit before loading only the demo in Pi", () => {
  const execute = vi.fn(() => ({ status: 0 }));
  expect(runShowcase({ execute })).toBe(0);
  const scripts = path.resolve("packages/pi-tui-kit/scripts");
  const options = { cwd: process.cwd(), stdio: "inherit" };
  expect(execute.mock.calls).toEqual([
    [process.execPath, [path.join(scripts, "build.mjs")], options],
    [
      "pi",
      ["--no-extensions", "--no-skills", "--no-session", "-e", path.join(scripts, "showcase/extension.ts")],
      options,
    ],
  ]);
});

test("showcase launcher stops before Pi when the build fails", () => {
  const execute = vi.fn(() => ({ status: 2 }));
  expect(runShowcase({ execute })).toBe(2);
  expect(execute).toHaveBeenCalledTimes(1);
});

test.each([{ status: 3 }, { status: null, signal: "SIGINT" }])("showcase launcher reports Pi failure: %j", (result) => {
  const execute = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce(result);
  expect(runShowcase({ execute })).toBe(result.status ?? 1);
  expect(execute).toHaveBeenCalledTimes(2);
});

test("showcase launcher reports a missing Pi executable", () => {
  const execute = vi
    .fn()
    .mockReturnValueOnce({ status: 0 })
    .mockReturnValueOnce({ error: new Error("spawnSync pi ENOENT") });
  const logError = vi.fn();
  expect(runShowcase({ execute, logError })).toBe(1);
  expect(logError).toHaveBeenCalledWith("spawnSync pi ENOENT");
});
