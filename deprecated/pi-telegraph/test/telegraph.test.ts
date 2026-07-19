import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import {
	createCustomSelectorHarness,
	createMockContext,
	createMockPi,
	driveCustomSelector,
} from "../../../test/support.js";
import { MAX_ERROR_DETAIL_BYTES, telegraphRequest } from "../src/client.js";
import { loadTelegraphConfig, writeTelegraphConfig } from "../src/config.js";
import telegraph, {
	buildStatusMessage,
	commandCompletions,
	normalizeTelegraphPath,
	parseCommand,
} from "../src/telegraph.js";

const TELEGRAPH_TOOL_NAMES = ["telegraph_create_page", "telegraph_get_page", "telegraph_edit_page"];

test("telegraph registers lifecycle tools, command, and session hooks", () => {
	const mock = createMockPi();
	telegraph(mock.pi);
	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		["telegraph_create_page", "telegraph_get_page", "telegraph_edit_page"],
	);
	assert.ok(mock.commands.has("telegraph"));
	assert.deepEqual([...mock.events.keys()].sort(), ["session_shutdown", "session_start"]);
	assert.match(JSON.stringify(mock.tools[0].parameters), /markdown/);
	assert.match(JSON.stringify(mock.tools[0].parameters), /nodes/);
	assert.match(JSON.stringify(mock.tools[0].promptGuidelines), /public/i);
});

test("command parsing, completion, and status remain secret-safe", () => {
	assert.deepEqual(parseCommand(""), { action: "status" });
	assert.deepEqual(parseCommand("status"), { action: "status" });
	assert.deepEqual(parseCommand("init"), { action: "init" });
	assert.deepEqual(parseCommand("tools"), { action: "tools" });
	assert.deepEqual(parseCommand("enable"), { action: "enable" });
	assert.deepEqual(parseCommand("disable"), { action: "disable" });
	assert.deepEqual(parseCommand("create docs/post.md"), {
		action: "create",
		filePath: "docs/post.md",
	});
	assert.deepEqual(parseCommand('create "docs/my post.md"'), {
		action: "create",
		filePath: "docs/my post.md",
	});
	assert.deepEqual(parseCommand("wat"), { action: "unknown" });
	assert.deepEqual(commandCompletions("st"), [
		{ value: "status", label: "status", description: "Show Telegraph config and tool status" },
	]);
	assert.equal(commandCompletions("status now"), null);
	const mock = createMockPi({ activeTools: ["read", "telegraph_get_page"] });
	const message = buildStatusMessage(mock.pi, {
		config: {
			shortName: "pi",
			authorName: "Writer",
			accessToken: "very-secret",
			tools: ["telegraph_get_page"],
			allowFilesOutsideWorkspace: true,
		} as never,
		path: "/tmp/pi-telegraph.json",
		exists: true,
	});
	assert.match(message, /account token: configured/);
	assert.match(message, /1\/3 active/i);
	assert.match(message, /telegraph_get_page/);
	assert.match(message, /outside workspace.*enabled/i);
	assert.match(message, /other active tools: 1/i);
	assert.doesNotMatch(message, /very-secret/);
});

test("session startup defaults tools off, applies subsets, and fails closed", async () => {
	await withTempAgentDir(async (agentDir) => {
		const missingMock = createMockPi({
			activeTools: ["read", ...TELEGRAPH_TOOL_NAMES],
		});
		telegraph(missingMock.pi);
		const missingContext = createMockContext();
		await missingMock.events.get("session_start")?.[0]?.({}, missingContext.ctx);
		assert.deepEqual(missingMock.rawPi.getActiveTools(), ["read"]);

		await writeFile(
			path.join(agentDir, "pi-telegraph.json"),
			'{"shortName":"legacy","accessToken":"legacy-secret"}\n',
			{ mode: 0o600 },
		);
		const legacyMock = createMockPi({ activeTools: ["read", ...TELEGRAPH_TOOL_NAMES] });
		telegraph(legacyMock.pi);
		await legacyMock.events.get("session_start")?.[0]?.({}, createMockContext().ctx);
		assert.deepEqual(legacyMock.rawPi.getActiveTools(), ["read"]);

		await writeTelegraphConfig({
			shortName: "configured",
			tools: ["telegraph_get_page"],
			allowFilesOutsideWorkspace: false,
		} as never);
		const configuredMock = createMockPi({
			activeTools: ["read", ...TELEGRAPH_TOOL_NAMES],
		});
		telegraph(configuredMock.pi);
		await configuredMock.events.get("session_start")?.[0]?.({}, createMockContext().ctx);
		assert.deepEqual(configuredMock.rawPi.getActiveTools(), ["read", "telegraph_get_page"]);

		await writeFile(
			path.join(agentDir, "pi-telegraph.json"),
			'{"shortName":"bad","tools":["telegraph_unknown"]}\n',
			{ mode: 0o600 },
		);
		const invalidMock = createMockPi({
			activeTools: ["read", ...TELEGRAPH_TOOL_NAMES],
		});
		telegraph(invalidMock.pi);
		const invalidContext = createMockContext();
		await invalidMock.events.get("session_start")?.[0]?.({}, invalidContext.ctx);
		assert.deepEqual(invalidMock.rawPi.getActiveTools(), ["read"]);
		assert.match(
			invalidContext.notifications.map((item) => item.message).join("\n"),
			/config ignored.*tools/i,
		);
	});
});

test("tool control commands apply immediately and preserve config credentials", async () => {
	await withTempAgentDir(async () => {
		await writeTelegraphConfig({
			shortName: "existing",
			accessToken: "keep-secret",
			tools: [],
			allowFilesOutsideWorkspace: true,
		} as never);
		const mock = createMockPi({ activeTools: ["read"] });
		telegraph(mock.pi);
		const { ctx } = createMockContext();
		const command = mock.commands.get("telegraph");

		await command?.handler("enable", ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", ...TELEGRAPH_TOOL_NAMES]);
		assert.deepEqual((await loadTelegraphConfig()).config, {
			shortName: "existing",
			accessToken: "keep-secret",
			tools: TELEGRAPH_TOOL_NAMES,
			allowFilesOutsideWorkspace: true,
		});

		await command?.handler("disable", ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
		assert.deepEqual((await loadTelegraphConfig()).config, {
			shortName: "existing",
			accessToken: "keep-secret",
			tools: [],
			allowFilesOutsideWorkspace: true,
		});
	});
});

test("/telegraph tools selects individual tools and persists atomically", async () => {
	await withTempAgentDir(async () => {
		await writeTelegraphConfig({
			shortName: "existing",
			accessToken: "keep-secret",
			tools: [],
			allowFilesOutsideWorkspace: false,
		} as never);
		const answers = ["[ ] telegraph_get_page", "Done"];
		const mock = createMockPi({ activeTools: ["read"] });
		telegraph(mock.pi);
		const { ctx } = createMockContext({
			hasUI: true,
			select: async () => answers.shift(),
		});
		await mock.commands.get("telegraph")?.handler("tools", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "telegraph_get_page"]);
		assert.deepEqual((await loadTelegraphConfig()).config, {
			shortName: "existing",
			accessToken: "keep-secret",
			tools: ["telegraph_get_page"],
			allowFilesOutsideWorkspace: false,
		});
		assert.equal((await stat((await loadTelegraphConfig()).path)).mode & 0o777, 0o600);
	});
});

test("/telegraph tools keeps the cursor on the toggled custom-selector row", async () => {
	await withTempAgentDir(async () => {
		await writeTelegraphConfig({ shortName: "existing", accessToken: "keep-secret" });
		const mock = createMockPi({ activeTools: ["read"] });
		telegraph(mock.pi);
		let customCalled = false;
		const { ctx } = createMockContext({
			hasUI: true,
			custom: async (factory: unknown) => {
				customCalled = true;
				const { renders, result } = driveCustomSelector(factory, [
					"tui.select.down",
					"tui.select.confirm",
					"tui.select.cancel",
				]);
				assert.ok(renders[1]?.some((line) => line.includes("› [x] telegraph_get_page")));
				return result;
			},
		});
		await mock.commands.get("telegraph")?.handler("tools", ctx);

		assert.equal(customCalled, true);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "telegraph_get_page"]);
		assert.deepEqual((await loadTelegraphConfig()).config.tools, ["telegraph_get_page"]);
	});
});

test("/telegraph tools keeps runtime and selector state unchanged when persistence fails", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeTelegraphConfig({
			shortName: "existing",
			accessToken: "keep-secret",
			tools: [],
		});
		const configPath = (await loadTelegraphConfig()).path;
		const backupPath = path.join(agentDir, "telegraph-backup.json");
		await rename(configPath, backupPath);
		await symlink(backupPath, configPath);

		const mock = createMockPi({ activeTools: ["read"] });
		telegraph(mock.pi);
		let notificationLog: Array<{ message: string }> = [];
		const context = createMockContext({
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory);
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
				await waitFor(() =>
					notificationLog.some((item) => /Unable to update Telegraph tools/.test(item.message)),
				);
				assert.ok(harness.render().some((line) => line.includes("› [ ] telegraph_get_page")));
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		});
		notificationLog = context.notifications;
		await mock.commands.get("telegraph")?.handler("tools", context.ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
		assert.deepEqual(JSON.parse(await readFile(backupPath, "utf8")).tools, []);
	});
});

test("/telegraph help documents tool defaults and file-title safety rules", async () => {
	const mock = createMockPi();
	telegraph(mock.pi);
	const context = createMockContext();
	await mock.commands.get("telegraph")?.handler("help", context.ctx);
	const message = context.notifications.map((item) => item.message).join("\n");
	assert.match(message, /tools are disabled by default/i);
	assert.match(message, /YAML frontmatter title.*first H1.*filename/i);
	assert.match(message, /allowFilesOutsideWorkspace/);
});

test("/telegraph init writes non-secret defaults and preserves imported credentials", async () => {
	await withTempAgentDir(async () => {
		await writeTelegraphConfig({ shortName: "old", accessToken: "keep-secret" });
		const mock = createMockPi();
		telegraph(mock.pi);
		const answers = ["new-name", "Writer", "https://example.com/writer"];
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			input: async () => answers.shift(),
		});
		await mock.commands.get("telegraph")?.handler("init", ctx);
		assert.deepEqual((await loadTelegraphConfig()).config, {
			shortName: "new-name",
			authorName: "Writer",
			authorUrl: "https://example.com/writer",
			accessToken: "keep-secret",
			tools: [],
			allowFilesOutsideWorkspace: false,
		});
		assert.doesNotMatch(notifications.map((item) => item.message).join("\n"), /keep-secret/);
	});
});

test("create validates one content format and cancellation performs no request or write", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi();
		telegraph(mock.pi);
		const create = tool(mock, "telegraph_create_page");
		const calls: FetchCall[] = [];
		await withMockFetch(
			calls,
			async () => {
				throw new Error("unexpected fetch");
			},
			async () => {
				const { ctx } = createMockContext({ hasUI: true, confirm: async () => false });
				const cancelled = await execute(create, { title: "No", markdown: "body" }, ctx);
				assert.match(resultText(cancelled), /cancelled/i);
				await assert.rejects(
					execute(create, { title: "Bad", markdown: "a", nodes: ["b"] }, ctx),
					/exactly one/i,
				);
			},
		);
		assert.equal(calls.length, 0);
		assert.equal((await loadTelegraphConfig()).exists, false);
	});
});

test("headless create requires confirmed true, creates one account, persists it, and publishes", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi();
		telegraph(mock.pi);
		const create = tool(mock, "telegraph_create_page");
		const { ctx } = createMockContext({ hasUI: false });
		const calls: FetchCall[] = [];
		await withMockFetch(
			calls,
			async (url) => {
				if (url.endsWith("/createAccount")) {
					return jsonResponse({
						ok: true,
						result: {
							short_name: "pi-telegraph",
							access_token: "generated-secret",
							auth_url: "https://edit.telegra.ph/auth/generated-secret",
						},
					});
				}
				return jsonResponse({
					ok: true,
					result: { path: "Hello-01-01", url: "https://telegra.ph/Hello-01-01", title: "Hello" },
				});
			},
			async () => {
				await assert.rejects(
					execute(create, { title: "Hello", markdown: "world" }, ctx),
					/confirmed: true/i,
				);
				const result = await execute(
					create,
					{ title: "Hello", markdown: "world", confirmed: true },
					ctx,
				);
				assert.match(resultText(result), /https:\/\/telegra\.ph\/Hello-01-01/);
				assert.match(resultText(result), /account created: yes/i);
				assert.doesNotMatch(JSON.stringify(result), /generated-secret/);
			},
		);

		assert.equal(calls.length, 2);
		assert.equal(calls[0]?.url, "https://api.telegra.ph/createAccount");
		assert.equal(calls[1]?.url, "https://api.telegra.ph/createPage");
		assert.equal(form(calls[1]).get("access_token"), "generated-secret");
		assert.equal(form(calls[1]).get("title"), "Hello");
		assert.deepEqual(JSON.parse(form(calls[1]).get("content") ?? ""), [
			{ tag: "p", children: ["world"] },
		]);
		assert.deepEqual((await loadTelegraphConfig()).config, {
			shortName: "pi-telegraph",
			accessToken: "generated-secret",
			tools: [],
			allowFilesOutsideWorkspace: false,
		});
	});
});

test("configured accounts publish equivalent Markdown/raw nodes and apply author overrides", async () => {
	await withTempAgentDir(async () => {
		await writeTelegraphConfig({
			shortName: "imported",
			authorName: "Default Author",
			authorUrl: "https://example.com/default",
			accessToken: "imported-secret",
		});
		const mock = createMockPi();
		telegraph(mock.pi);
		const create = tool(mock, "telegraph_create_page");
		const { ctx } = createMockContext({ hasUI: false });
		const calls: FetchCall[] = [];
		await withMockFetch(
			calls,
			async (_url, init) => {
				const title = new URLSearchParams(init.body as string).get("title") ?? "Page";
				return jsonResponse({
					ok: true,
					result: {
						path: `${title}-01-01`,
						url: `https://telegra.ph/${title}-01-01`,
						title,
					},
				});
			},
			async () => {
				await execute(create, { title: "Markdown", markdown: "same", confirmed: true }, ctx);
				await execute(
					create,
					{
						title: "Nodes",
						nodes: [{ tag: "p", children: ["same"] }],
						authorName: "",
						authorUrl: "",
						confirmed: true,
					},
					ctx,
				);
			},
		);
		assert.equal(calls.length, 2);
		assert.deepEqual(JSON.parse(form(calls[0]).get("content") ?? ""), [
			{ tag: "p", children: ["same"] },
		]);
		assert.deepEqual(
			JSON.parse(form(calls[1]).get("content") ?? ""),
			JSON.parse(form(calls[0]).get("content") ?? ""),
		);
		assert.equal(form(calls[0]).get("author_name"), "Default Author");
		assert.equal(form(calls[0]).get("author_url"), "https://example.com/default");
		assert.equal(form(calls[1]).get("author_name"), "");
		assert.equal(form(calls[1]).get("author_url"), "");
		assert.ok(calls.every((call) => !call.url.endsWith("/createAccount")));
	});
});

test("concurrent first creates share one lazy account registration", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi();
		telegraph(mock.pi);
		const create = tool(mock, "telegraph_create_page");
		const { ctx } = createMockContext({ hasUI: false });
		let accountCalls = 0;
		let pageCalls = 0;
		const calls: FetchCall[] = [];
		await withMockFetch(
			calls,
			async (url) => {
				if (url.endsWith("/createAccount")) {
					accountCalls += 1;
					await new Promise((resolve) => setTimeout(resolve, 20));
					return jsonResponse({
						ok: true,
						result: { short_name: "pi-telegraph", access_token: "shared-secret" },
					});
				}
				pageCalls += 1;
				return jsonResponse({
					ok: true,
					result: {
						path: `Page-${pageCalls}`,
						url: `https://telegra.ph/Page-${pageCalls}`,
						title: "Page",
					},
				});
			},
			async () => {
				await Promise.all([
					execute(create, { title: "One", markdown: "one", confirmed: true }, ctx),
					execute(create, { title: "Two", markdown: "two", confirmed: true }, ctx),
				]);
			},
		);
		assert.equal(accountCalls, 1);
		assert.equal(pageCalls, 2);
	});
});

test("concurrent tools retain and restore status until every operation finishes", async () => {
	await withTempAgentDir(async () => {
		await writeTelegraphConfig({ shortName: "existing", accessToken: "status-secret" });
		const mock = createMockPi();
		telegraph(mock.pi);
		const create = tool(mock, "telegraph_create_page");
		const get = tool(mock, "telegraph_get_page");
		const { ctx, statuses } = createMockContext({ hasUI: false });
		const createResponse = deferred<Response>();
		const getResponse = deferred<Response>();
		const calls: FetchCall[] = [];
		await withMockFetch(
			calls,
			async (url) => {
				if (url.endsWith("/createPage")) return createResponse.promise;
				if (url.includes("/getPage/")) return getResponse.promise;
				throw new Error(`unexpected request: ${url}`);
			},
			async () => {
				const creating = execute(
					create,
					{ title: "Status", markdown: "body", confirmed: true },
					ctx,
				);
				await waitFor(() => calls.some((call) => call.url.endsWith("/createPage")));
				assert.equal(statuses.get("telegraph"), "publishing");

				const getting = execute(get, { path: "Sample-01-01" }, ctx);
				await waitFor(() => calls.some((call) => call.url.includes("/getPage/")));
				assert.equal(statuses.get("telegraph"), "fetching");

				getResponse.resolve(pageResponse());
				await getting;
				assert.equal(statuses.get("telegraph"), "publishing");

				createResponse.resolve(
					jsonResponse({
						ok: true,
						result: {
							path: "Status-01-01",
							url: "https://telegra.ph/Status-01-01",
							title: "Status",
						},
					}),
				);
				await creating;
				assert.equal(statuses.get("telegraph"), undefined);
			},
		);
	});
});

test("tool completion does not reuse a stale extension context after replacement", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi();
		telegraph(mock.pi);
		const get = tool(mock, "telegraph_get_page");
		const base = createMockContext({ hasUI: false });
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
				const getting = execute(get, { path: "Stale-01-01" }, ctx);
				await waitFor(() => calls.length === 1);
				stale = true;
				response.resolve(
					jsonResponse({
						ok: true,
						result: {
							path: "Stale-01-01",
							url: "https://telegra.ph/Stale-01-01",
							title: "Stale",
							content: [{ tag: "p", children: ["body"] }],
						},
					}),
				);
				await getting;
				assert.equal(base.statuses.get("telegraph"), undefined);
			},
		);
	});
});

test("get normalizes bare paths and Telegraph URLs and rejects foreign URLs", async () => {
	assert.equal(normalizeTelegraphPath("/Sample-Page-12-15"), "Sample-Page-12-15");
	assert.equal(normalizeTelegraphPath("https://telegra.ph/Sample-Page-12-15"), "Sample-Page-12-15");
	assert.throws(() => normalizeTelegraphPath("https://example.com/Sample"), /telegra\.ph/i);
	assert.throws(() => normalizeTelegraphPath("https://telegra.ph/a/b"), /path/i);

	await withTempAgentDir(async () => {
		const mock = createMockPi();
		telegraph(mock.pi);
		const get = tool(mock, "telegraph_get_page");
		const calls: FetchCall[] = [];
		await withMockFetch(
			calls,
			async () => pageResponse(),
			async () => {
				const { ctx } = createMockContext();
				const markdown = await execute(get, { path: "https://telegra.ph/Sample-01-01" }, ctx);
				assert.match(resultText(markdown), /Hello \*\*world\*\*/);
				const raw = await execute(get, { path: "Sample-01-01", rawNodes: true }, ctx);
				assert.match(resultText(raw), /"tag": "strong"/);
			},
		);
		assert.ok(calls.every((call) => call.url.endsWith("/getPage/Sample-01-01")));
		assert.ok(calls.every((call) => form(call).get("return_content") === "true"));
	});
});

test("partial edit preserves omitted fields and refuses to invent an account", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi();
		telegraph(mock.pi);
		const edit = tool(mock, "telegraph_edit_page");
		const { ctx } = createMockContext({ hasUI: false });
		await assert.rejects(
			execute(edit, { path: "Sample-01-01", title: "New", confirmed: true }, ctx),
			/\/telegraph init|accessToken/i,
		);

		await writeTelegraphConfig({ shortName: "existing", accessToken: "edit-secret" });
		const calls: FetchCall[] = [];
		await withMockFetch(
			calls,
			async (url) => {
				if (url.includes("/getPage/")) return pageResponse();
				return jsonResponse({
					ok: true,
					result: {
						path: "Sample-01-01",
						url: "https://telegra.ph/Sample-01-01",
						title: "New title",
						author_name: "Old Author",
					},
				});
			},
			async () => {
				const result = await execute(
					edit,
					{ path: "Sample-01-01", title: "New title", confirmed: true },
					ctx,
				);
				assert.match(resultText(result), /Updated Telegraph page/);
			},
		);
		assert.equal(calls.length, 2);
		const editForm = form(calls[1]);
		assert.equal(editForm.get("access_token"), "edit-secret");
		assert.equal(editForm.get("title"), "New title");
		assert.equal(editForm.get("author_name"), "Old Author");
		assert.equal(editForm.get("author_url"), "https://example.com/old");
		assert.deepEqual(JSON.parse(editForm.get("content") ?? ""), [
			{ tag: "p", children: ["Hello ", { tag: "strong", children: ["world"] }] },
		]);
	});
});

test("client rejects malformed, invalid JSON, and unsuccessful HTTP responses", async () => {
	const responses = [
		new Response("not-json", { status: 200 }),
		jsonResponse({ unexpected: true }),
		jsonResponse({ ok: true, result: { value: 1 } }, { status: 503 }),
	];
	const calls: FetchCall[] = [];
	await withMockFetch(
		calls,
		async () => responses.shift() ?? jsonResponse({ ok: true, result: {} }),
		async () => {
			await assert.rejects(
				telegraphRequest(
					"createPage",
					undefined,
					{ access_token: "invalid-json-secret", title: "x" },
					undefined,
					100,
				),
				(error: Error) => {
					assert.match(error.message, /invalid JSON/i);
					assert.doesNotMatch(error.message, /invalid-json-secret/);
					return true;
				},
			);
			await assert.rejects(
				telegraphRequest("getPage", "Sample", {}, undefined, 100),
				/malformed response envelope/i,
			);
			await assert.rejects(telegraphRequest("getPage", "Sample", {}, undefined, 100), /503/);
		},
	);
	assert.equal(calls.length, 3);
});

test("client bounds oversized remote error details after redacting credentials", async () => {
	const calls: FetchCall[] = [];
	await withMockFetch(
		calls,
		async () => new Response(`error-secret ${"x".repeat(MAX_ERROR_DETAIL_BYTES * 4)}`),
		async () => {
			await assert.rejects(
				telegraphRequest("createPage", undefined, { access_token: "error-secret" }, undefined, 100),
				(error: Error) => {
					assert.doesNotMatch(error.message, /error-secret/);
					assert.match(error.message, /\[REDACTED\]/);
					assert.match(error.message, /truncated/i);
					assert.ok(Buffer.byteLength(error.message) <= MAX_ERROR_DETAIL_BYTES + 256);
					return true;
				},
			);
		},
	);
});

test("API failures redact tokens and status is cleared on errors and aborts", async () => {
	await withTempAgentDir(async () => {
		await writeTelegraphConfig({ shortName: "existing", accessToken: "top-secret-token" });
		const mock = createMockPi();
		telegraph(mock.pi);
		const create = tool(mock, "telegraph_create_page");
		const { ctx, statuses } = createMockContext({ hasUI: false });
		const calls: FetchCall[] = [];
		await withMockFetch(
			calls,
			async () =>
				jsonResponse(
					{ ok: false, error: "ACCESS_TOKEN_INVALID top-secret-token" },
					{ status: 400 },
				),
			async () => {
				await assert.rejects(
					execute(create, { title: "Bad", markdown: "body", confirmed: true }, ctx),
					(error: Error) => {
						assert.doesNotMatch(error.message, /top-secret-token/);
						assert.match(error.message, /\[REDACTED\]/);
						return true;
					},
				);
			},
		);
		assert.equal(statuses.get("telegraph"), undefined);

		const controller = new AbortController();
		controller.abort(new Error("user stopped"));
		await assert.rejects(
			telegraphRequest("getPage", "Sample", { return_content: true }, controller.signal, 100),
			/user stopped|abort/i,
		);
		await assert.rejects(
			execute(
				create,
				{ title: "Abort", markdown: "body", confirmed: true },
				ctx,
				controller.signal,
			),
			/user stopped|abort/i,
		);
		assert.equal(statuses.get("telegraph"), undefined);
	});
});

test("request timeout covers both connection and response-body reads without retrying", async () => {
	const calls: FetchCall[] = [];
	await withMockFetch(
		calls,
		async (_url, init) => {
			await new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
			throw new Error("unreachable");
		},
		async () => {
			await assert.rejects(
				telegraphRequest("getPage", "Sample", { return_content: true }, undefined, 5),
				/timed out/i,
			);
		},
	);
	assert.equal(calls.length, 1);

	calls.length = 0;
	await withMockFetch(
		calls,
		async (_url, init) =>
			({
				ok: true,
				status: 200,
				statusText: "OK",
				async text() {
					await new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
							once: true,
						});
					});
					return "";
				},
			}) as Response,
		async () => {
			await assert.rejects(
				telegraphRequest("getPage", "Sample", { return_content: true }, undefined, 5),
				/timed out/i,
			);
		},
	);
	assert.equal(calls.length, 1);
});

test("temporary outputs are isolated across concurrent extension sessions", async () => {
	await withTempAgentDir(async () => {
		const firstMock = createMockPi();
		const secondMock = createMockPi();
		telegraph(firstMock.pi);
		telegraph(secondMock.pi);
		const firstContext = createMockContext();
		const firstCtx = firstContext.ctx as unknown as { ui: unknown };
		const secondContext = createMockContext({ ui: firstCtx.ui });
		const calls: FetchCall[] = [];
		let firstPath: string | undefined;
		let secondPath: string | undefined;
		await withMockFetch(
			calls,
			async (url) => {
				const path = url.endsWith("/First-01-01") ? "First-01-01" : "Second-01-01";
				return jsonResponse({
					ok: true,
					result: {
						path,
						url: `https://telegra.ph/${path}`,
						title: path.startsWith("First") ? "First" : "Second",
						content: [{ tag: "p", children: ["x".repeat(60_000)] }],
					},
				});
			},
			async () => {
				const firstResult = await execute(
					tool(firstMock, "telegraph_get_page"),
					{ path: "First-01-01" },
					firstContext.ctx,
				);
				const secondResult = await execute(
					tool(secondMock, "telegraph_get_page"),
					{ path: "Second-01-01" },
					secondContext.ctx,
				);
				firstPath = (firstResult.details as { fullOutputPath?: string }).fullOutputPath;
				secondPath = (secondResult.details as { fullOutputPath?: string }).fullOutputPath;
			},
		);
		assert.ok(firstPath);
		assert.ok(secondPath);
		await firstMock.events.get("session_shutdown")?.[0]?.({}, firstContext.ctx);
		await assert.rejects(stat(firstPath));
		assert.equal((await stat(secondPath)).isFile(), true);
		await secondMock.events.get("session_shutdown")?.[0]?.({}, secondContext.ctx);
		await assert.rejects(stat(secondPath));
	});
});

test("large get output is truncated to Pi limits, saved privately, and cleaned on shutdown", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi();
		telegraph(mock.pi);
		const get = tool(mock, "telegraph_get_page");
		const { ctx } = createMockContext();
		let result: ToolResult | undefined;
		const calls: FetchCall[] = [];
		await withMockFetch(
			calls,
			async () =>
				jsonResponse({
					ok: true,
					result: {
						path: "Large-01-01",
						url: "https://telegra.ph/Large-01-01",
						title: "Large",
						views: 1,
						content: [{ tag: "p", children: ["x".repeat(60_000)] }],
					},
				}),
			async () => {
				result = await execute(get, { path: "Large-01-01" }, ctx);
			},
		);
		assert.ok(result);
		const text = resultText(result);
		assert.ok(Buffer.byteLength(text) <= DEFAULT_MAX_BYTES);
		assert.match(text, /Full output saved to:/);
		const outputPath = (result.details as { fullOutputPath?: string }).fullOutputPath;
		assert.ok(outputPath);
		assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
		assert.ok((await readFile(outputPath, "utf8")).length > text.length);
		await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
		await assert.rejects(stat(outputPath));
	});
});

type FetchCall = { url: string; init: RequestInit };
type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown };

function tool(mock: ReturnType<typeof createMockPi>, name: string) {
	const found = mock.tools.find((candidate) => candidate.name === name);
	assert.ok(found, `missing tool: ${name}`);
	return found as {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			ctx: unknown,
		) => Promise<ToolResult>;
	};
}

function execute(
	toolDefinition: ReturnType<typeof tool>,
	params: Record<string, unknown>,
	ctx: unknown,
	signal?: AbortSignal,
) {
	return toolDefinition.execute("call-1", params, signal, undefined, ctx);
}

function resultText(result: ToolResult) {
	return result.content.map((item) => item.text ?? "").join("\n");
}

function form(call: FetchCall | undefined) {
	assert.ok(call);
	assert.equal(typeof call.init.body, "string");
	return new URLSearchParams(call.init.body as string);
}

function jsonResponse(payload: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(payload), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

function pageResponse() {
	return jsonResponse({
		ok: true,
		result: {
			path: "Sample-01-01",
			url: "https://telegra.ph/Sample-01-01",
			title: "Old title",
			author_name: "Old Author",
			author_url: "https://example.com/old",
			views: 7,
			content: [{ tag: "p", children: ["Hello ", { tag: "strong", children: ["world"] }] }],
		},
	});
}

async function withMockFetch(
	calls: FetchCall[],
	responder: (url: string, init: RequestInit) => Promise<Response>,
	fn: () => Promise<void>,
): Promise<void>;
async function withMockFetch(
	calls: FetchCall[],
	responder: (url: string, init: RequestInit) => Promise<Response>,
): Promise<void>;
async function withMockFetch(
	calls: FetchCall[],
	responder: (url: string, init: RequestInit) => Promise<Response>,
	fn?: () => Promise<void>,
) {
	const previous = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		const url = String(input);
		calls.push({ url, init });
		return responder(url, init);
	};
	try {
		if (fn) await fn();
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
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-telegraph-tool-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await fn(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
}
