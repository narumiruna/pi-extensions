import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";

const packageRoot = resolve("packages/pi-stamp");
const builderUrl = pathToFileURL(join(packageRoot, "scripts/build-runtime.mjs")).href;
const require = createRequire(join(packageRoot, "package.json"));
const resolvedKitRoot = require.resolve
	.paths("@narumitw/pi-tui-kit")
	?.map((modulesRoot) => join(modulesRoot, "@narumitw", "pi-tui-kit"))
	.find((candidate) => existsSync(join(candidate, "package.json")));
assert.ok(resolvedKitRoot, "pi-stamp's resolved pi-tui-kit dependency is missing");
const forbiddenEagerInputs: readonly string[] = ["src/menu.ts"];

type BuildMetadata = {
	outputs?: Record<
		string,
		{
			entryPoint?: string;
			imports?: Array<{ external?: boolean; kind?: string; path: string }>;
			inputs?: Record<string, unknown>;
		}
	>;
};

type RuntimeBuilder = {
	buildRuntime(options?: {
		outputDirectory?: string;
		validateOutput?: (outputDirectory: string) => Promise<void>;
	}): Promise<BuildMetadata>;
	validateEagerGraph(metadata: BuildMetadata): {
		eagerInputs: Set<string>;
		eagerOutputs: Set<string>;
	};
	publishRuntime(
		stagingDirectory: string,
		outputDirectory: string,
		operations?: { renamePath?: typeof rename },
	): Promise<void>;
};

async function loadBuilder(): Promise<RuntimeBuilder> {
	return (await import(`${builderUrl}?test=${crypto.randomUUID()}`)) as RuntimeBuilder;
}

function validMetadata(): BuildMetadata {
	const entryImports: Array<{ external?: boolean; kind?: string; path: string }> = [
		{ path: "@earendil-works/pi-coding-agent", kind: "import-statement", external: true },
		{ path: "@narumitw/pi-tui-kit", kind: "dynamic-import", external: true },
	];
	const outputs: NonNullable<BuildMetadata["outputs"]> = {
		"dist/index.ts": {
			entryPoint: "src/index.ts",
			imports: entryImports,
			inputs: { "src/index.ts": {}, "src/runtime.ts": {} },
		},
	};
	for (const [index, input] of forbiddenEagerInputs.entries()) {
		const outputPath = `dist/chunks/lazy-${index}.ts`;
		entryImports.push({ path: outputPath, kind: "dynamic-import" });
		outputs[outputPath] = { entryPoint: input, imports: [], inputs: { [input]: {} } };
	}
	return { outputs };
}

test("eager graph validation preserves first-use boundaries and external packages", async () => {
	const builder = await loadBuilder();
	assert.doesNotThrow(() => builder.validateEagerGraph(validMetadata()));

	for (const forbidden of forbiddenEagerInputs) {
		const metadata = validMetadata();
		const entry = requireOutput(metadata, "dist/index.ts");
		entry.inputs = { ...(entry.inputs ?? {}), [forbidden]: {} };
		assert.throws(
			() => builder.validateEagerGraph(metadata),
			new RegExp(`First-use implementation is eager: ${forbidden.replaceAll("/", "\\/")}`, "u"),
		);
	}

	const eagerDependency = validMetadata();
	const entry = requireOutput(eagerDependency, "dist/index.ts");
	entry.imports = [
		...(entry.imports ?? []),
		{ path: "@narumitw/pi-tui-kit", kind: "import-statement", external: true },
	];
	assert.throws(
		() => builder.validateEagerGraph(eagerDependency),
		/Eager external dependency: @narumitw\/pi-tui-kit/u,
	);

	const bundledDependency = validMetadata();
	requireOutput(bundledDependency, "dist/index.ts").inputs = {
		"node_modules/example/index.js": {},
	};
	assert.throws(
		() => builder.validateEagerGraph(bundledDependency),
		/Bundled package input: .*node_modules\/example/u,
	);
});

test("only the dependency-free Kit terminal-text leaf may load eagerly", async () => {
	const builder = await loadBuilder();
	for (const [specifier, allowed] of [
		["@narumitw/pi-tui-kit/terminal-text", true],
		["@narumitw/pi-tui-kit/terminal-document", false],
		["@narumitw/pi-tui-kit/testing", false],
		["@narumitw/pi-tui-kit/terminal-text/other", false],
	] as const) {
		const metadata = validMetadata();
		requireOutput(metadata, "dist/index.ts").imports?.push({
			path: specifier,
			kind: "import-statement",
			external: true,
		});
		if (allowed) assert.doesNotThrow(() => builder.validateEagerGraph(metadata));
		else assert.throws(() => builder.validateEagerGraph(metadata), /Eager external dependency/u);
	}
	const manifest = JSON.parse(await readFile(join(resolvedKitRoot, "package.json"), "utf8"));
	const leaf = manifest.exports["./terminal-text"].import;
	assert.equal(leaf, "./dist/terminal-text.js");
	const source = await readFile(join(resolvedKitRoot, leaf), "utf8");
	assert.doesNotMatch(source, /\b(?:import\s|import\(|require\(|from\s+["'])/u);
});

test("runtime build rejects destructive output paths and symlink escapes", async () => {
	const builder = await loadBuilder();
	const outside = await mkdtemp(join(tmpdir(), "pi-stamp-build-outside-"));
	const linkedParent = join(packageRoot, `.pi-stamp-build-test-link-${crypto.randomUUID()}`);
	try {
		await assert.rejects(
			builder.buildRuntime({ outputDirectory: packageRoot }),
			/Runtime output directory must be inside the package root/u,
		);
		await assert.rejects(
			builder.buildRuntime({ outputDirectory: join(outside, "dist") }),
			/Runtime output directory must be inside the package root/u,
		);
		await symlink(outside, linkedParent, "dir");
		await assert.rejects(
			builder.buildRuntime({ outputDirectory: join(linkedParent, "dist") }),
			/Runtime output parent must not escape the package root through a symlink/u,
		);
	} finally {
		await rm(linkedParent, { force: true, recursive: true });
		await rm(outside, { force: true, recursive: true });
	}
});

test("runtime builds are deterministic, mapped, external, and remove stale output", async () => {
	const builder = await loadBuilder();
	const root = await mkdtemp(join(packageRoot, ".pi-stamp-build-test-"));
	try {
		const first = join(root, "first");
		const second = join(root, "second");
		const firstMetadata = await builder.buildRuntime({ outputDirectory: first });
		await mkdir(join(second, "chunks"), { recursive: true });
		await writeFile(join(second, "chunks", "stale.ts"), "stale", "utf8");
		await builder.buildRuntime({ outputDirectory: second });

		assert.deepEqual(await snapshotDirectory(first), await snapshotDirectory(second));
		assert.equal((await listFiles(second)).includes("chunks/stale.ts"), false);
		const files = await listFiles(first);
		assert.ok(files.includes("index.ts"));
		assert.ok(files.includes("index.ts.map"));
		assert.equal(
			files.some((path) => path.startsWith("chunks/") && path.endsWith(".ts")),
			forbiddenEagerInputs.length > 0,
		);
		for (const runtimePath of files.filter((path) => path.endsWith(".ts"))) {
			const source = await readFile(join(first, runtimePath), "utf8");
			assert.match(source, /^\/\/ @generated by scripts\/build-runtime\.mjs/u);
			assert.doesNotMatch(source, /["']\.\.?\/[^"']+\.js["']/u);
			assert.doesNotMatch(source, /["']\.\.?\/[^"']*src\//u);
			assert.ok(files.includes(`${runtimePath}.map`), `missing map for ${runtimePath}`);
		}
		assert.match(
			await readFile(join(first, "index.ts"), "utf8"),
			/["']\.\/chunks\/[^"']+\.ts["']/u,
		);
		for (const output of Object.values(firstMetadata.outputs ?? {})) {
			for (const input of Object.keys(output.inputs ?? {})) {
				assert.equal(input.includes("node_modules/"), false, `bundled package input: ${input}`);
			}
		}
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
	const builder = await loadBuilder();
	const root = await mkdtemp(join(packageRoot, ".pi-stamp-build-test-"));
	const agentDir = join(root, "agent");
	const output = join(root, "dist");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		await builder.buildRuntime({ outputDirectory: output });
		await mkdir(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory({}),
			additionalExtensionPaths: [join(output, "index.ts")],
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		const extension = loaded.extensions[0];
		assert.ok(extension?.commands.has("stamp"));
		assert.ok(extension?.handlers.has("session_start"));
		assert.ok(extension?.handlers.has("session_shutdown"));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { force: true, recursive: true });
	}
});

test("generated lazy boundary resolves Pi peers through Jiti aliases", async () => {
	const builder = await loadBuilder();
	const buildRoot = await mkdtemp(join(packageRoot, ".pi-stamp-build-test-"));
	const isolatedRoot = await mkdtemp(join(tmpdir(), "pi-stamp-isolated-runtime-"));
	const agentDir = join(isolatedRoot, "agent");
	const output = join(buildRoot, "dist");
	const isolatedOutput = join(isolatedRoot, "dist");
	const isolatedKitRoot = join(isolatedRoot, "node_modules", "@narumitw", "pi-tui-kit");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		await builder.buildRuntime({ outputDirectory: output });
		await cp(output, isolatedOutput, { recursive: true });
		await mkdir(isolatedKitRoot, { recursive: true });
		await cp(join(resolvedKitRoot, "dist"), join(isolatedKitRoot, "dist"), {
			recursive: true,
		});
		await cp(join(resolvedKitRoot, "package.json"), join(isolatedKitRoot, "package.json"));
		await assert.rejects(access(join(isolatedRoot, "node_modules", "@earendil-works", "pi-tui")));

		await mkdir(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const loader = new DefaultResourceLoader({
			cwd: isolatedRoot,
			agentDir,
			settingsManager: SettingsManager.inMemory({}),
			additionalExtensionPaths: [join(isolatedOutput, "index.ts")],
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const command = loaded.extensions[0]?.commands.get("stamp");
		assert.ok(command);
		const { ctx } = createMockContext({ cwd: isolatedRoot, mode: "tui" });
		await command.handler("", ctx);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(buildRoot, { force: true, recursive: true });
		await rm(isolatedRoot, { force: true, recursive: true });
	}
});

test("failed validation and publication preserve the previous runtime", async () => {
	const builder = await loadBuilder();
	const root = await mkdtemp(join(packageRoot, ".pi-stamp-build-test-"));
	try {
		const output = join(root, "dist");
		await mkdir(output, { recursive: true });
		await writeFile(join(output, "previous.ts"), "previous", "utf8");
		await assert.rejects(
			builder.buildRuntime({
				outputDirectory: output,
				validateOutput: async () => {
					throw new Error("injected validation failure");
				},
			}),
			/injected validation failure/u,
		);
		assert.deepEqual(await listFiles(output), ["previous.ts"]);

		const staging = join(root, "staging");
		await mkdir(staging, { recursive: true });
		await writeFile(join(staging, "next.ts"), "next", "utf8");
		let renameCalls = 0;
		await assert.rejects(
			builder.publishRuntime(staging, output, {
				renamePath: async (source, destination) => {
					renameCalls += 1;
					if (renameCalls === 2) throw new Error("injected publication failure");
					await rename(source, destination);
				},
			}),
			/injected publication failure/u,
		);
		assert.deepEqual(await listFiles(output), ["previous.ts"]);
		assert.deepEqual(
			(await readdir(root)).filter((entry) => entry.includes(".backup-")),
			[],
		);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

function requireOutput(metadata: BuildMetadata, path: string) {
	const output = metadata.outputs?.[path];
	assert.ok(output, `missing fixture output: ${path}`);
	return output;
}

async function snapshotDirectory(directory: string): Promise<Record<string, string>> {
	const snapshot: Record<string, string> = {};
	for (const path of await listFiles(directory)) {
		snapshot[path] = await readFile(join(directory, path), "base64");
	}
	return snapshot;
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
		const relativePath = join(prefix, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(directory, relativePath)));
		else if (entry.isFile()) files.push(relativePath.replaceAll("\\", "/"));
	}
	return files.sort();
}
