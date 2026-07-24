import { defineModule, type ExtensionStatusIconAliasMap } from "./types.js";

const DEFAULT_EXTENSION_STATUS_ICONS: Record<string, string> = {
	accounts: "👤",
	caffeinate: "💊",
	"chrome-devtools": "🌐",
	"codex-usage": "📊",
	firecrawl: "🔥",
	"github-pr": "🔎",
	goal: "🎯",
	"google-genai": "✨",
	lsp: "🧰",
	"plan-mode": "📝",
	retry: "🔁",
	pisync: "🔄",
	subagents: "🧑‍🤝‍🧑",
	sync: "🔄",
	usage: "📊",
	"unknown-error-retry": "🔁",
};

const COMPATIBLE_STATUS_ICON_KEYS: Readonly<Record<string, string>> = {
	retry: "unknown-error-retry",
	sync: "pisync",
	"unknown-error-retry": "retry",
	pisync: "sync",
};

export const extensionStatusModule = defineModule({
	name: "extension_status",
	variables: ["symbol", "statuses", "count"],
	defaults: {
		format: "[$statuses]($style)",
		symbol: "",
		style: "fg:extension",
		disabled: false,
	},
	values: ({ runtime, extensionStatus, hiddenExtensionStatusKeys }) => {
		const statuses = [...runtime.extensionStatuses.entries()]
			.filter(
				([key, value]) => key !== "starship" && !hiddenExtensionStatusKeys.has(key) && value.trim(),
			)
			.map(([key, value]) =>
				formatExtensionStatus(
					key,
					value,
					extensionStatus.icons,
					runtime.extensionStatusIconAliases,
				),
			)
			.slice(0, extensionStatus.maxStatuses);
		if (statuses.length === 0) return undefined;
		return {
			statuses: statuses.join(extensionStatus.separator),
			count: `${statuses.length}`,
		};
	},
});

export function formatExtensionStatus(
	key: string,
	value: string,
	configuredIcons: Readonly<Record<string, string>>,
	aliases: ExtensionStatusIconAliasMap,
): string {
	const status = splitExtensionStatusIcon(stripExtensionStatusPrefix(key, value));
	const icon = extensionStatusIcon(key, status.icon, configuredIcons, aliases);
	const text = simplifyExtensionStatusText(status.text);
	return icon ? `${icon} ${text}` : text;
}

function extensionStatusIcon(
	key: string,
	leadingIcon: string | undefined,
	configuredIcons: Readonly<Record<string, string>>,
	aliases: ExtensionStatusIconAliasMap,
): string {
	if (Object.hasOwn(configuredIcons, key)) return configuredIcons[key] ?? "";
	const namespaceIcon = configuredNamespaceIcon(key, configuredIcons);
	if (namespaceIcon !== undefined) return namespaceIcon;
	const compatibleKey = COMPATIBLE_STATUS_ICON_KEYS[key];
	if (compatibleKey && Object.hasOwn(configuredIcons, compatibleKey)) {
		return configuredIcons[compatibleKey] ?? "";
	}
	for (const alias of extensionStatusAliasesForKey(key, aliases)) {
		if (Object.hasOwn(configuredIcons, alias)) return configuredIcons[alias] ?? "";
	}
	const defaultIcon = Object.hasOwn(DEFAULT_EXTENSION_STATUS_ICONS, key)
		? DEFAULT_EXTENSION_STATUS_ICONS[key]
		: undefined;
	const fallbackIcon = Object.hasOwn(configuredIcons, "fallback")
		? configuredIcons.fallback
		: undefined;
	return leadingIcon ?? defaultIcon ?? fallbackIcon ?? "🔌";
}

function configuredNamespaceIcon(
	key: string,
	configuredIcons: Readonly<Record<string, string>>,
): string | undefined {
	let match: { baseLength: number; icon: string } | undefined;
	for (const [selector, icon] of Object.entries(configuredIcons)) {
		if (!selector.endsWith(":*")) continue;
		const base = selector.slice(0, -2);
		if (!base || !key.startsWith(`${base}:`)) continue;
		if (!match || base.length > match.baseLength) match = { baseLength: base.length, icon };
	}
	return match?.icon;
}

function extensionStatusAliasesForKey(
	key: string,
	aliases: ExtensionStatusIconAliasMap,
): readonly string[] {
	for (const [base, values] of aliases) {
		if (key === base || key.startsWith(`${base}:`) || key.startsWith(`${base}/`)) return values;
	}
	return [];
}

function splitExtensionStatusIcon(value: string): { icon?: string; text: string } {
	const trimmed = value.trim();
	const [first, ...rest] = trimmed.split(/\s+/u);
	if (first && isEmojiOnlyToken(first)) return { icon: first, text: rest.join(" ") };
	return { text: trimmed };
}

function isEmojiOnlyToken(value: string): boolean {
	return /^(?=.*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\ufe0f?\u20e3))(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|[0-9#*]\ufe0f?\u20e3)+$/u.test(
		value,
	);
}

function stripExtensionStatusPrefix(key: string, value: string): string {
	return value.trim().replace(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*`, "iu"), "");
}

function simplifyExtensionStatusText(value: string): string {
	return value
		.trim()
		.replace(/\bready\b/giu, "✓")
		.replace(/\bmissing\b/giu, "✗")
		.replace(/,\s*/g, " ")
		.replace(/\s+\([^)]*\)\s*$/u, "")
		.replace(/\s+/gu, " ");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface InstalledPackage {
	packageName: string;
	source?: string;
}

export function buildExtensionStatusIconAliases(
	packages: readonly InstalledPackage[],
): Map<string, string[]> {
	const candidates = new Map<string, Map<string, string[]>>();
	for (const installed of packages) {
		const base = installed.packageName.slice(installed.packageName.lastIndexOf("/") + 1);
		const statusBase = base.startsWith("pi-") ? base.slice(3) : base;
		if (!statusBase) continue;
		const sourceAliases = installed.source?.startsWith("npm:")
			? [installed.source, `npm:${npmPackageName(installed.source)}`]
			: [];
		const aliases = [...new Set([...sourceAliases, installed.packageName, base, statusBase])];
		const byPackage = candidates.get(statusBase) ?? new Map<string, string[]>();
		byPackage.set(installed.packageName, aliases);
		candidates.set(statusBase, byPackage);
	}
	const result = new Map<string, string[]>();
	for (const [base, byPackage] of candidates) {
		if (byPackage.size === 1) result.set(base, [...byPackage.values()][0] ?? []);
	}
	return result;
}

function npmPackageName(source: string): string {
	const spec = source.slice("npm:".length);
	if (spec.startsWith("@")) return spec.split("@").slice(0, 2).join("@").replace(/^@/u, "@");
	return spec.split("@")[0] ?? spec;
}
