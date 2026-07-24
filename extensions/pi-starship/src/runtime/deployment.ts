import { extname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	directMatch,
	exactAlias,
	isRecord,
	joinHome,
	MAX_METADATA_FILE_BYTES,
	optionBoolean,
	optionMap,
	optionNumber,
	optionStrings,
	runBounded,
	safeMetadata,
} from "./helpers.js";
import type { CollectorContext, MutableModuleSnapshot } from "./types.js";

export async function collectDeployment(context: CollectorContext): Promise<MutableModuleSnapshot> {
	const result: MutableModuleSnapshot = {};
	if (context.needs("docker_context")) {
		const docker = await collectDocker(context);
		if (docker) result.docker_context = docker;
	}
	if (context.needs("kubernetes")) {
		const kubernetes = await collectKubernetes(context);
		if (kubernetes) result.kubernetes = kubernetes;
	}
	if (context.needs("terraform")) {
		const terraform = await collectTerraform(context);
		if (terraform) result.terraform = terraform;
	}
	return result;
}

async function collectDocker(
	context: CollectorContext,
): Promise<Record<string, string> | undefined> {
	const entries = await context.entries();
	if (optionBoolean(context, "docker_context", "only_with_files")) {
		const configuredFiles = optionStrings(context, "docker_context", "detect_files");
		if (
			!directMatch(
				entries,
				configuredFiles.length > 0
					? configuredFiles
					: [
							"Dockerfile",
							"docker-compose.yml",
							"docker-compose.yaml",
							"compose.yml",
							"compose.yaml",
						],
				optionStrings(context, "docker_context", "detect_extensions"),
				optionStrings(context, "docker_context", "detect_folders"),
			)
		) {
			return undefined;
		}
	}
	let active = safeMetadata(context.input.environment.DOCKER_CONTEXT);
	if (!active) {
		const configDirectory =
			safeMetadata(context.input.environment.DOCKER_CONFIG, 1_024) ??
			joinHome(context.input, ".docker");
		const source = await context.fs.readFile(
			join(configDirectory, "config.json"),
			MAX_METADATA_FILE_BYTES,
		);
		if (source) {
			try {
				const document = JSON.parse(source) as unknown;
				active = isRecord(document) ? safeMetadata(document.currentContext) : undefined;
			} catch {
				// Malformed metadata degrades to an empty module.
			}
		}
	}
	return active && active !== "default" ? { context: active } : undefined;
}

async function collectKubernetes(
	context: CollectorContext,
): Promise<Record<string, string> | undefined> {
	const selected = safeMetadata(context.input.environment.KUBECONFIG, 4_096);
	const candidates = selected
		? selected.split(context.input.platform === "win32" ? ";" : ":").filter(Boolean)
		: [joinHome(context.input, ".kube", "config")];
	const limit = optionNumber(context, "kubernetes", "max_config_files") ?? 8;
	const contexts = new Map<string, Record<string, unknown>>();
	const clusters = new Set<string>();
	const users = new Set<string>();
	let currentContext: string | undefined;
	for (const path of candidates.slice(0, limit)) {
		const source = await context.fs.readFile(path, MAX_METADATA_FILE_BYTES);
		if (!source) continue;
		try {
			const document = parseYaml(source) as unknown;
			if (!isRecord(document)) continue;
			currentContext ??= safeMetadata(document["current-context"]);
			for (const item of arrayRecords(document.contexts)) {
				const name = safeMetadata(item.name);
				if (name && !contexts.has(name) && isRecord(item.context)) contexts.set(name, item.context);
			}
			for (const item of arrayRecords(document.clusters)) {
				const name = safeMetadata(item.name);
				if (name) clusters.add(name);
			}
			for (const item of arrayRecords(document.users)) {
				const name = safeMetadata(item.name);
				if (name) users.add(name);
			}
		} catch {
			// Ignore malformed files independently.
		}
	}
	if (!currentContext) return undefined;
	const selectedContext = contexts.get(currentContext);
	const cluster = safeMetadata(selectedContext?.cluster);
	const user = safeMetadata(selectedContext?.user);
	const namespace = safeMetadata(selectedContext?.namespace) ?? "default";
	const values: Record<string, string> = {
		context:
			exactAlias(currentContext, optionMap(context, "kubernetes", "context_aliases")) ??
			currentContext,
		namespace:
			exactAlias(namespace, optionMap(context, "kubernetes", "namespace_aliases")) ?? namespace,
	};
	if (cluster && clusters.has(cluster)) {
		values.cluster =
			exactAlias(cluster, optionMap(context, "kubernetes", "cluster_aliases")) ?? cluster;
	}
	if (user && users.has(user)) {
		values.user = exactAlias(user, optionMap(context, "kubernetes", "user_aliases")) ?? user;
	}
	return values;
}

async function collectTerraform(
	context: CollectorContext,
): Promise<Record<string, string> | undefined> {
	const entries = await context.entries();
	const configuredFiles = optionStrings(context, "terraform", "detect_files");
	const configuredExtensions = optionStrings(context, "terraform", "detect_extensions");
	const configuredFolders = optionStrings(context, "terraform", "detect_folders");
	const detected =
		configuredFiles.length + configuredExtensions.length + configuredFolders.length > 0
			? directMatch(entries, configuredFiles, configuredExtensions, configuredFolders)
			: entries.some(
					(entry) =>
						(entry.isFile && [".tf", ".tfplan", ".tfstate"].includes(extname(entry.name))) ||
						(entry.isDirectory && entry.name === ".terraform"),
				);
	if (!detected) return undefined;
	const values: Record<string, string> = {};
	const workspace = await terraformWorkspace(context);
	if (workspace) values.workspace = workspace;
	if (context.needs("terraform", "version")) {
		for (const command of ["terraform", "tofu"]) {
			const output = await runBounded(context, command, ["version"]);
			const parsed = output ? parseTerraformVersion(output, command) : undefined;
			if (parsed) {
				values.version = parsed;
				break;
			}
		}
	}
	return values;
}

async function terraformWorkspace(context: CollectorContext): Promise<string | undefined> {
	const direct = safeMetadata(context.input.environment.TF_WORKSPACE);
	if (direct) return direct;
	const dataDirectory = safeMetadata(context.input.environment.TF_DATA_DIR, 1_024);
	const candidate = dataDirectory
		? join(
				isAbsolute(dataDirectory) ? dataDirectory : resolve(context.input.cwd, dataDirectory),
				"environment",
			)
		: join(context.input.cwd, ".terraform", "environment");
	return safeMetadata(await context.fs.readFile(candidate, 1_024));
}

export function parseTerraformVersion(
	output: string,
	command: "terraform" | "tofu" | string,
): string | undefined {
	const escaped = command === "tofu" ? "OpenTofu" : "Terraform";
	const match = new RegExp(`^${escaped} v?(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)$`, "u").exec(
		output.trim().split(/\r?\n/u)[0] ?? "",
	);
	return match?.[1] ? `v${match[1]}` : undefined;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}
