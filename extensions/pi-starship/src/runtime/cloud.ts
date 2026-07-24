import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	exactAlias,
	isRecord,
	joinHome,
	MAX_METADATA_FILE_BYTES,
	optionBoolean,
	optionMap,
	parseIni,
	safeMetadata,
} from "./helpers.js";
import type { CollectorContext, MutableModuleSnapshot } from "./types.js";

export async function collectCloud(context: CollectorContext): Promise<MutableModuleSnapshot> {
	const result: MutableModuleSnapshot = {};
	if (context.needs("aws")) {
		const values = await collectAws(context);
		if (values) result.aws = values;
	}
	if (context.needs("gcloud")) {
		const values = await collectGcloud(context);
		if (values) result.gcloud = values;
	}
	if (context.needs("azure")) {
		const values = await collectAzure(context);
		if (values) result.azure = values;
	}
	if (context.needs("openstack")) {
		const values = await collectOpenstack(context);
		if (values) result.openstack = values;
	}
	return result;
}

async function collectAws(context: CollectorContext): Promise<Record<string, string> | undefined> {
	const env = context.input.environment;
	const profile = safeMetadata(env.AWS_PROFILE ?? env.AWS_DEFAULT_PROFILE) ?? "default";
	let region = safeMetadata(env.AWS_REGION ?? env.AWS_DEFAULT_REGION);
	if (!region) {
		const configPath =
			safeMetadata(env.AWS_CONFIG_FILE, 1_024) ?? joinHome(context.input, ".aws", "config");
		const source = await context.fs.readFile(configPath, MAX_METADATA_FILE_BYTES);
		if (source) {
			const section = profile === "default" ? "default" : `profile ${profile}`;
			region = safeMetadata(parseIni(source)[section]?.region);
		}
	}
	if (profile === "default" && !region && !env.AWS_PROFILE && !env.AWS_DEFAULT_PROFILE)
		return undefined;
	const values: Record<string, string> = {
		profile: exactAlias(profile, optionMap(context, "aws", "profile_aliases")) ?? profile,
	};
	if (region)
		values.region = exactAlias(region, optionMap(context, "aws", "region_aliases")) ?? region;
	return values;
}

async function collectGcloud(
	context: CollectorContext,
): Promise<Record<string, string> | undefined> {
	const env = context.input.environment;
	const directory =
		safeMetadata(env.CLOUDSDK_CONFIG, 1_024) ?? joinHome(context.input, ".config", "gcloud");
	const active =
		safeMetadata(env.CLOUDSDK_ACTIVE_CONFIG_NAME) ??
		safeMetadata(await context.fs.readFile(join(directory, "active_config"), 256));
	if (!active || !/^[A-Za-z0-9_-]+$/u.test(active)) return undefined;
	const source = await context.fs.readFile(
		join(directory, "configurations", `config_${active}`),
		MAX_METADATA_FILE_BYTES,
	);
	if (!source) return { active };
	const document = parseIni(source);
	const account = safeMetadata(document.core?.account);
	const project = safeMetadata(document.core?.project);
	const region = safeMetadata(document.compute?.region);
	const values: Record<string, string> = { active };
	if (account) {
		values.account = account;
		const separator = account.lastIndexOf("@");
		if (separator >= 0 && separator < account.length - 1)
			values.domain = account.slice(separator + 1);
	}
	if (project) {
		values.project =
			exactAlias(project, optionMap(context, "gcloud", "project_aliases")) ?? project;
	}
	if (region)
		values.region = exactAlias(region, optionMap(context, "gcloud", "region_aliases")) ?? region;
	return values;
}

async function collectAzure(
	context: CollectorContext,
): Promise<Record<string, string> | undefined> {
	const directory =
		safeMetadata(context.input.environment.AZURE_CONFIG_DIR, 1_024) ??
		joinHome(context.input, ".azure");
	const source = await context.fs.readFile(
		join(directory, "azureProfile.json"),
		MAX_METADATA_FILE_BYTES,
	);
	if (!source) return undefined;
	try {
		const document = JSON.parse(source.replace(/^\uFEFF/u, "")) as unknown;
		const subscriptions =
			isRecord(document) && Array.isArray(document.subscriptions)
				? document.subscriptions.filter(isRecord)
				: [];
		const selected = subscriptions.find((item) => item.isDefault === true) ?? subscriptions[0];
		const subscription = safeMetadata(selected?.name);
		if (!subscription) return undefined;
		const values: Record<string, string> = {
			subscription:
				exactAlias(subscription, optionMap(context, "azure", "subscription_aliases")) ??
				subscription,
		};
		if (optionBoolean(context, "azure", "show_username")) {
			const user = isRecord(selected?.user) ? selected.user : undefined;
			const username = safeMetadata(user?.name);
			if (username) values.username = username;
		}
		return values;
	} catch {
		return undefined;
	}
}

async function collectOpenstack(
	context: CollectorContext,
): Promise<Record<string, string> | undefined> {
	const env = context.input.environment;
	const cloud = safeMetadata(env.OS_CLOUD);
	let project = safeMetadata(env.OS_PROJECT_NAME);
	if (!cloud) return undefined;
	if (!project) {
		const path =
			safeMetadata(env.OS_CLIENT_CONFIG_FILE, 1_024) ??
			joinHome(context.input, ".config", "openstack", "clouds.yaml");
		const source = await context.fs.readFile(path, MAX_METADATA_FILE_BYTES);
		if (source) {
			try {
				const document = parseYaml(source) as unknown;
				const clouds =
					isRecord(document) && isRecord(document.clouds) ? document.clouds : undefined;
				const selected =
					clouds && Object.hasOwn(clouds, cloud) && isRecord(clouds[cloud])
						? clouds[cloud]
						: undefined;
				const auth = isRecord(selected?.auth) ? selected.auth : undefined;
				project = safeMetadata(auth?.project_name);
			} catch {
				// Malformed YAML is ignored.
			}
		}
	}
	const values: Record<string, string> = {
		cloud: exactAlias(cloud, optionMap(context, "openstack", "cloud_aliases")) ?? cloud,
	};
	if (project) {
		values.project =
			exactAlias(project, optionMap(context, "openstack", "project_aliases")) ?? project;
	}
	return values;
}
