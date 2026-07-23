import fs from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
	agentDir,
	isExplicitlyEnabled,
	loadPartialConfig,
	localConfigPath,
	updateLocalConfig,
} from "./config.js";
import {
	DEFAULT_SYNC_FILES,
	isSafeExtraFileName,
	normalizeExtraFiles,
	normalizeSyncFiles,
} from "./sync-policy.js";

const INCLUDED = "included";
const EXCLUDED = "excluded";
const BUILT_IN_PREFIX = "builtin:";
const EXTRA_PREFIX = "extra:";
const SESSIONS_ID = "sessions";

export async function showFileSelection(ctx: ExtensionCommandContext) {
	const partial = await loadPartialConfig();
	const selectedBuiltIns = new Set(normalizeSyncFiles(partial.syncFiles));
	const selectedExtras = new Set(normalizeExtraFiles(partial.extraFiles));
	const sessionEnvironmentOverride = Object.hasOwn(process.env, "PI_SYNC_SESSIONS");
	const sessionsIncluded = isExplicitlyEnabled(partial.syncSessions);
	const extraCandidates = await listExtraFileCandidates(selectedExtras);

	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			[
				"pi-sync selected files:",
				`built-ins: ${[...selectedBuiltIns].join(", ") || "none"}`,
				`sessions: ${sessionsIncluded ? "included" : "excluded"}${sessionEnvironmentOverride ? " (PI_SYNC_SESSIONS)" : ""}`,
				`extra files: ${[...selectedExtras].map(safeTerminalText).join(", ") || "none"}`,
				`Edit syncFiles, syncSessions, and extraFiles in ${safeTerminalText(localConfigPath())}.`,
			].join("\n"),
			"info",
		);
		return;
	}

	const items: SettingItem[] = [
		...DEFAULT_SYNC_FILES.map((fileName) => ({
			id: `${BUILT_IN_PREFIX}${fileName}`,
			label: fileName,
			description: fileName.includes(".")
				? `Sync the top-level ${fileName} file when present.`
				: `Recursively sync every safe file under ${fileName}/.`,
			currentValue: selectedBuiltIns.has(fileName) ? INCLUDED : EXCLUDED,
			values: [INCLUDED, EXCLUDED],
		})),
		{
			id: SESSIONS_ID,
			label: "sessions",
			description: sessionEnvironmentOverride
				? "Read-only here because PI_SYNC_SESSIONS overrides the local setting. Session JSONL may contain prompts, tool output, paths, images, and secrets."
				: "Session JSONL may contain prompts, tool output, paths, images, and secrets. Sync only to storage you trust.",
			currentValue: sessionEnvironmentOverride
				? `${sessionsIncluded ? INCLUDED : EXCLUDED} (environment)`
				: sessionsIncluded
					? INCLUDED
					: EXCLUDED,
			...(sessionEnvironmentOverride ? {} : { values: [INCLUDED, EXCLUDED] }),
		},
		...extraCandidates.map((fileName) => ({
			id: `${EXTRA_PREFIX}${fileName}`,
			label: safeTerminalText(fileName),
			description:
				"Additional safe top-level file. It may be absent locally and pulled from another machine.",
			currentValue: selectedExtras.has(fileName) ? INCLUDED : EXCLUDED,
			values: [INCLUDED, EXCLUDED],
		})),
	];

	let saveQueue = Promise.resolve();
	let nextOwner = 0;
	const owners = new Map<string, number>();
	let closed = false;

	await ctx.ui.custom((tui, theme, _keybindings, done) => {
		const container = new Container();
		const title = new Text("", 1, 0);
		const hint = new Text("", 1, 0);
		const updateChrome = () => {
			title.setText(theme.fg("accent", theme.bold("pi-sync Files")));
			hint.setText(
				theme.fg("dim", "Changes save immediately and apply to the next manual or automatic sync."),
			);
		};
		updateChrome();
		container.addChild(title);

		let settingsList: SettingsList;
		const queueChange = (id: string, newValue: string) => {
			const previousValue = newValue === INCLUDED ? EXCLUDED : INCLUDED;
			const owner = ++nextOwner;
			owners.set(id, owner);
			const save = async () => {
				try {
					await persistSelectionChange(id, newValue === INCLUDED);
				} catch (error) {
					if (owners.get(id) === owner && !closed) {
						settingsList.updateValue(id, previousValue);
						tui.requestRender();
					}
					ctx.ui.notify(`Could not save pi-sync file selection: ${errorMessage(error)}`, "error");
				}
			};
			saveQueue = saveQueue.then(save, save);
		};

		settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			queueChange,
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(settingsList);
		container.addChild(hint);

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				updateChrome();
				container.invalidate();
			},
			handleInput(data: string) {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
	closed = true;
	await saveQueue;
}

async function listExtraFileCandidates(configured: Set<string>) {
	const candidates = new Map([...configured].map((fileName) => [fileName.toLowerCase(), fileName]));
	try {
		for (const entry of await fs.readdir(agentDir(), { withFileTypes: true })) {
			if (!entry.isFile() || !isSafeExtraFileName(entry.name)) continue;
			if (!candidates.has(entry.name.toLowerCase())) {
				candidates.set(entry.name.toLowerCase(), entry.name);
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return [...candidates.values()].sort((left, right) => left.localeCompare(right));
}

async function persistSelectionChange(id: string, included: boolean) {
	await updateLocalConfig((current) => {
		if (id.startsWith(BUILT_IN_PREFIX)) {
			const fileName = id.slice(BUILT_IN_PREFIX.length);
			const selected = new Set(normalizeSyncFiles(current.syncFiles));
			if (included) selected.add(fileName as (typeof DEFAULT_SYNC_FILES)[number]);
			else selected.delete(fileName as (typeof DEFAULT_SYNC_FILES)[number]);
			return {
				...current,
				syncFiles: DEFAULT_SYNC_FILES.filter((candidate) => selected.has(candidate)),
			};
		}
		if (id.startsWith(EXTRA_PREFIX)) {
			const fileName = id.slice(EXTRA_PREFIX.length);
			const selected = new Set(normalizeExtraFiles(current.extraFiles));
			if (included) selected.add(fileName);
			else selected.delete(fileName);
			return { ...current, extraFiles: [...selected] };
		}
		if (id === SESSIONS_ID) return { ...current, syncSessions: included };
		throw new Error(`Unknown file selection: ${id}`);
	});
}

function safeTerminalText(value: string) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}

function errorMessage(error: unknown) {
	return safeTerminalText(error instanceof Error ? error.message : String(error));
}
