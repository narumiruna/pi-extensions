import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadTelegraphConfig, writeTelegraphConfig } from "../src/config.js";
import telegraph from "../src/telegraph.js";

const TELEGRAPH_TOOL_NAMES = ["telegraph_create_page", "telegraph_get_page", "telegraph_edit_page"];

type FetchCall = { url: string; init: RequestInit };

test("/telegraph create publishes files with frontmatter, H1, and basename title precedence", async () => {
	await withTempAgentDir(async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-telegraph-workspace-"));
		try {
			await mkdir(path.join(workspace, "docs"));
			await writeFile(
				path.join(workspace, "docs", "metadata.md"),
				"---\ntitle: Metadata title\nignored: value\n---\n# Body heading\n\nBody text.\n",
			);
			await writeFile(
				path.join(workspace, "docs", "heading.md"),
				"# Hello *world*\n\nBody text.\n",
			);
			await writeFile(path.join(workspace, "docs", "my post.markdown"), "Body only.\n");
			await writeFile(path.join(workspace, "docs", "UPPER.MD"), "Uppercase extension.\n");
			await symlink("metadata.md", path.join(workspace, "docs", "internal-link.md"));
			await writeTelegraphConfig({ shortName: "existing", accessToken: "file-secret" });

			const mock = createMockPi({ activeTools: TELEGRAPH_TOOL_NAMES });
			telegraph(mock.pi);
			const context = createMockContext({ cwd: workspace, hasUI: true, confirm: async () => true });
			await mock.events.get("session_start")?.[0]?.({}, context.ctx);
			assert.deepEqual(mock.rawPi.getActiveTools(), []);
			const calls: FetchCall[] = [];
			await withMockFetch(
				calls,
				async (_url, init) => {
					const title = new URLSearchParams(init.body as string).get("title") ?? "Page";
					return jsonResponse({
						ok: true,
						result: {
							path: `${title.replaceAll(" ", "-")}-01-01`,
							url: `https://telegra.ph/${title.replaceAll(" ", "-")}-01-01`,
							title,
						},
					});
				},
				async () => {
					const command = mock.commands.get("telegraph");
					await command?.handler("create docs/metadata.md", context.ctx);
					await command?.handler("create docs/heading.md", context.ctx);
					await command?.handler('create "docs/my post.markdown"', context.ctx);
					await command?.handler("create docs/UPPER.MD", context.ctx);
					await command?.handler("create docs/internal-link.md", context.ctx);
				},
			);

			assert.equal(calls.length, 5);
			assert.deepEqual(
				calls.map((call) => form(call).get("title")),
				["Metadata title", "Hello world", "my post", "UPPER", "Metadata title"],
			);
			assert.deepEqual(JSON.parse(form(calls[0]).get("content") ?? ""), [
				{ tag: "h3", children: ["Body heading"] },
				{ tag: "p", children: ["Body text."] },
			]);
			assert.deepEqual(JSON.parse(form(calls[1]).get("content") ?? ""), [
				{ tag: "h3", children: ["Hello ", { tag: "em", children: ["world"] }] },
				{ tag: "p", children: ["Body text."] },
			]);
			const messages = context.notifications.map((item) => item.message).join("\n");
			assert.match(messages, /Metadata title/);
			assert.match(messages, /https:\/\/telegra\.ph\/Metadata-title-01-01/);
			assert.match(messages, /account created: no/i);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

test("/telegraph create cancellation performs no request or account write", async () => {
	await withTempAgentDir(async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-telegraph-cancel-"));
		try {
			await writeFile(path.join(workspace, "cancel.md"), "# Do not publish\n");
			const mock = createMockPi();
			telegraph(mock.pi);
			const context = createMockContext({
				cwd: workspace,
				hasUI: true,
				confirm: async () => false,
			});
			const calls: FetchCall[] = [];
			await withMockFetch(
				calls,
				async () => {
					throw new Error("unexpected fetch");
				},
				async () => {
					await mock.commands.get("telegraph")?.handler("create cancel.md", context.ctx);
				},
			);
			assert.equal(calls.length, 0);
			assert.equal((await loadTelegraphConfig()).exists, false);
			assert.match(context.notifications.map((item) => item.message).join("\n"), /cancelled/i);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

test("/telegraph create rejects invalid files and workspace escapes before requests", async () => {
	await withTempAgentDir(async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-telegraph-scope-"));
		const outside = await mkdtemp(path.join(os.tmpdir(), "pi-telegraph-outside-"));
		try {
			await writeFile(path.join(workspace, "valid.md"), "# Valid\n");
			await writeFile(path.join(workspace, "wrong.txt"), "# Wrong\n");
			await mkdir(path.join(workspace, "directory.md"));
			await writeFile(path.join(workspace, "bad-yaml.md"), "---\ntitle: [\n---\nBody\n");
			await writeFile(path.join(workspace, "bad-title.md"), "---\ntitle: 42\n---\nBody\n");
			await writeFile(path.join(workspace, "blank-title.md"), '---\ntitle: ""\n---\nBody\n');
			await writeFile(path.join(workspace, "empty.md"), "---\ntitle: Empty\n---\n");
			await writeFile(path.join(workspace, "large.md"), "x".repeat(256 * 1024 + 1));
			const outsideFile = path.join(outside, "outside.md");
			await writeFile(outsideFile, "# Outside\n");
			await symlink(outsideFile, path.join(workspace, "escape.md"));

			const mock = createMockPi();
			telegraph(mock.pi);
			const context = createMockContext({ cwd: workspace, hasUI: true, confirm: async () => true });
			const calls: FetchCall[] = [];
			await withMockFetch(
				calls,
				async () => {
					throw new Error("unexpected fetch");
				},
				async () => {
					const command = mock.commands.get("telegraph");
					for (const args of [
						"create",
						"create missing.md",
						"create wrong.txt",
						"create directory.md",
						"create bad-yaml.md",
						"create bad-title.md",
						"create blank-title.md",
						"create empty.md",
						"create large.md",
						`create ${path.join(workspace, "valid.md")}`,
						`create ${path.relative(workspace, outsideFile)}`,
						"create escape.md",
					]) {
						await command?.handler(args, context.ctx);
					}
				},
			);
			assert.equal(calls.length, 0);
			const messages = context.notifications.map((item) => item.message).join("\n");
			assert.match(messages, /Usage: \/telegraph create/);
			assert.match(messages, /not found|ENOENT/i);
			assert.match(messages, /\.md or \.markdown/i);
			assert.match(messages, /regular file/i);
			assert.match(messages, /frontmatter|YAML/i);
			assert.match(messages, /title.*string/i);
			assert.match(messages, /content|body.*empty/i);
			assert.match(messages, /too large|256/i);
			assert.match(messages, /absolute/i);
			assert.match(messages, /outside.*workspace/i);
		} finally {
			await Promise.all([
				rm(workspace, { recursive: true, force: true }),
				rm(outside, { recursive: true, force: true }),
			]);
		}
	});
});

test("/telegraph create requires interactive confirmation before reading for publication", async () => {
	await withTempAgentDir(async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-telegraph-headless-file-"));
		try {
			await writeFile(path.join(workspace, "valid.md"), "# Valid\n");
			const mock = createMockPi();
			telegraph(mock.pi);
			const context = createMockContext({ cwd: workspace, hasUI: false });
			const calls: FetchCall[] = [];
			await withMockFetch(
				calls,
				async () => {
					throw new Error("unexpected fetch");
				},
				async () => {
					await mock.commands.get("telegraph")?.handler("create valid.md", context.ctx);
				},
			);
			assert.equal(calls.length, 0);
			assert.match(
				context.notifications.map((item) => item.message).join("\n"),
				/requires interactive UI/i,
			);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

test("/telegraph create completion does not reuse a stale command context", async () => {
	await withTempAgentDir(async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-telegraph-stale-command-"));
		try {
			await writeFile(path.join(workspace, "stale.md"), "# Stale-safe title\n");
			await writeTelegraphConfig({ shortName: "existing", accessToken: "stale-secret" });
			const mock = createMockPi();
			telegraph(mock.pi);
			const base = createMockContext({ cwd: workspace, hasUI: true, confirm: async () => true });
			const baseCtx = base.ctx as unknown as Record<string, unknown> & { ui: unknown };
			let stale = false;
			const ctx = {
				...baseCtx,
				get ui() {
					if (stale) throw new Error("stale extension ctx");
					return baseCtx.ui;
				},
			};
			const response = deferred<Response>();
			const calls: FetchCall[] = [];
			await withMockFetch(
				calls,
				async () => response.promise,
				async () => {
					const publishing = mock.commands.get("telegraph")?.handler("create stale.md", ctx);
					await waitFor(() => calls.length === 1);
					stale = true;
					response.resolve(
						jsonResponse({
							ok: true,
							result: {
								path: "Stale-safe-title-01-01",
								url: "https://telegra.ph/Stale-safe-title-01-01",
								title: "Stale-safe title",
							},
						}),
					);
					await publishing;
				},
			);
			assert.match(base.notifications.map((item) => item.message).join("\n"), /Published/);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

test("/telegraph create permits configured absolute and outside-symlink paths", async () => {
	await withTempAgentDir(async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-telegraph-open-scope-"));
		const outside = await mkdtemp(path.join(os.tmpdir(), "pi-telegraph-open-outside-"));
		try {
			const outsideFile = path.join(outside, "outside.md");
			await writeFile(outsideFile, "# Outside title\n\nBody.\n");
			await symlink(outsideFile, path.join(workspace, "outside-link.md"));
			await writeTelegraphConfig({
				shortName: "existing",
				accessToken: "outside-secret",
				allowFilesOutsideWorkspace: true,
			});
			const mock = createMockPi();
			telegraph(mock.pi);
			const context = createMockContext({ cwd: workspace, hasUI: true, confirm: async () => true });
			const calls: FetchCall[] = [];
			await withMockFetch(
				calls,
				async () =>
					jsonResponse({
						ok: true,
						result: {
							path: "Outside-title-01-01",
							url: "https://telegra.ph/Outside-title-01-01",
							title: "Outside title",
						},
					}),
				async () => {
					const command = mock.commands.get("telegraph");
					await command?.handler(`create ${outsideFile}`, context.ctx);
					await command?.handler(`create ${path.relative(workspace, outsideFile)}`, context.ctx);
					await command?.handler("create outside-link.md", context.ctx);
				},
			);
			assert.equal(calls.length, 3);
			assert.ok(calls.every((call) => form(call).get("title") === "Outside title"));
		} finally {
			await Promise.all([
				rm(workspace, { recursive: true, force: true }),
				rm(outside, { recursive: true, force: true }),
			]);
		}
	});
});

function form(call: FetchCall | undefined) {
	assert.ok(call);
	assert.equal(typeof call.init.body, "string");
	return new URLSearchParams(call.init.body as string);
}

function jsonResponse(payload: unknown) {
	return new Response(JSON.stringify(payload), {
		headers: { "content-type": "application/json" },
	});
}

async function withMockFetch(
	calls: FetchCall[],
	responder: (url: string, init: RequestInit) => Promise<Response>,
	fn: () => Promise<void>,
) {
	const previous = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		const url = String(input);
		calls.push({ url, init });
		return responder(url, init);
	};
	try {
		await fn();
	} finally {
		globalThis.fetch = previous;
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for condition");
}

async function withTempAgentDir<T>(fn: (agentDir: string) => Promise<T>) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-telegraph-file-command-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await fn(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
}
