import fs from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { showAddGitTarget } from "../src/ui/setup/git-ui.js";
import { showSetupWizard } from "../src/ui/setup/setup-wizard.js";
import { withTempHome } from "./helpers.js";
import { createMockContext } from "./setup-test-context.js";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/daemon/pi-client.js", () => ({ piDaemonClient: () => ({ run, validate: vi.fn() }) }));

const ignoreChoice = "Use .syncignore (recommended)";
const pathPolicy = { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false, sessions: false };

test.each(["confirm first", "cancel first", "confirm additional"])("wizard %s setup with capable daemon", (choice) =>
  withTempHome(async (root) => {
    const settingsPath = join(root, "pi-sync.json");
    const rulePath = join(root, ".syncignore");
    const additional = choice === "confirm additional";
    const confirm = choice !== "cancel first";
    const connection = { type: "git", remote: "git@github.com:owner/private-pi-sync.git" };
    if (additional) {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
        settingsPath,
        JSON.stringify({
          version: 7,
          activeSyncSetup: "old",
          onSwitch: "switch-only",
          storageConnections: { old: connection },
          syncSetups: {
            old: {
              storage: { connection: "old", branch: "main", path: "./" },
              sync: { scope: "agent-directory", exclude: ["sessions"], automatic: false },
            },
          },
          unknownField: ["keep"],
        }),
        { mode: 0o600 },
      );
    }
    run.mockReset().mockResolvedValue({ available: true });
    let defaultChoice: string | undefined;
    let review: string | undefined;
    let fileAtReview: boolean | undefined;
    let settingsAtReview: string | undefined;
    const inputs = additional ? ["other-branch", "./"] : ["home", connection.remote, "", ""];
    const { ctx, notifications } = createMockContext({
      mode: "tui",
      input: async () => inputs.shift(),
      select: async (title: string, options: string[]) => {
        if (title.startsWith("Set up sync")) return "Git";
        if (title.startsWith("Choose synced content")) {
          defaultChoice = options[0];
          return defaultChoice;
        }
        if (title.startsWith("Session conversations")) return options[0];
        if (options.includes("Save setup") || options.includes("Add sync setup")) {
          review = title;
          fileAtReview = await fs.stat(rulePath).then(
            () => true,
            () => false,
          );
          settingsAtReview = await fs.readFile(settingsPath, "utf8").catch(() => undefined);
          return confirm ? options[0] : "Cancel";
        }
      },
    });
    const saved = additional ? await showAddGitTarget(ctx, "home", "old") : await showSetupWizard(ctx);
    expect(saved, JSON.stringify(notifications)).toBe(confirm);
    expect(defaultChoice).toBe(ignoreChoice);
    expect(review).toContain(rulePath);
    expect(review).toContain("/sessions/");
    expect(fileAtReview).toBe(false);
    expect(settingsAtReview !== undefined).toBe(additional);
    expect(run.mock.calls.map(([op]) => op)).toEqual(["ignore.capabilities"]);
    if (!confirm) {
      await expect(fs.stat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(rulePath)).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(settings.version).toBe(8);
    expect(settings.syncSetups.home.sync).toEqual(pathPolicy);
    if (additional) {
      expect(settings.activeSyncSetup).toBe("old");
      expect(settings.unknownField).toEqual(["keep"]);
    }
  }),
);
