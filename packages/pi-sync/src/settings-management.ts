import {
	effectiveSyncSetupRemoteIdentity,
	localConfigPath,
	normalizeSyncInclude,
	type SyncSetupStorageReview,
	syncSetupStorageReview,
	updateLocalConfig,
	validateConfigName,
} from "./config.js";
import type { PiSyncSettingsV3, StorageConnectionSettings, SyncSetupSettings } from "./types.js";

export class SyncSetupReviewChangedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SyncSetupReviewChangedError";
	}
}

export async function saveNewV3Settings(
	input: {
		setupName: string;
		connectionName: string;
		connection: StorageConnectionSettings;
		setup: SyncSetupSettings;
	},
	signal?: AbortSignal,
) {
	validateConfigName(input.setupName, "sync setup");
	validateConfigName(input.connectionName, "storage connection");
	const settings: PiSyncSettingsV3 = {
		version: 3,
		activeSyncSetup: input.setupName,
		onSwitch: "ask-before-pull",
		skipSecretScan: false,
		storageConnections: { [input.connectionName]: structuredClone(input.connection) },
		syncSetups: {
			[input.setupName]: {
				...structuredClone(input.setup),
				storage: { ...input.setup.storage, connection: input.connectionName },
			},
		},
	};
	await updateLocalConfig((current) => {
		if (Object.keys(current.storageConnections).length || Object.keys(current.syncSetups).length) {
			throw new Error(`Settings already exist: ${localConfigPath()}`);
		}
		return settings;
	}, signal);
	return settings;
}

export async function addStorageConnection(
	name: string,
	connection: StorageConnectionSettings,
	signal?: AbortSignal,
) {
	validateConfigName(name, "storage connection");
	await updateSettings((settings) => {
		if (Object.hasOwn(settings.storageConnections, name)) {
			throw new Error(`Storage connection already exists: ${name}`);
		}
		return {
			...settings,
			storageConnections: {
				...settings.storageConnections,
				[name]: structuredClone(connection),
			},
		};
	}, signal);
}

export async function updateStorageConnection(
	name: string,
	update: (connection: StorageConnectionSettings) => StorageConnectionSettings,
	expectedSetups?: readonly string[],
	signal?: AbortSignal,
) {
	validateConfigName(name, "storage connection");
	await updateSettings((settings) => {
		const connection = settings.storageConnections[name];
		if (!connection) throw new Error(`Storage connection not found: ${name}`);
		const currentSetups = referencingSetupNames(settings.syncSetups, name);
		if (expectedSetups && !sameNames(currentSetups, expectedSetups)) {
			throw new Error(
				`Storage connection “${name}” usage changed while it was open; reopen it and review the affected sync setups.`,
			);
		}
		const nextConnection = update(structuredClone(connection));
		const nextConnections = { ...settings.storageConnections, [name]: nextConnection };
		assertUniqueLocations(settings.syncSetups, nextConnections);
		return { ...settings, storageConnections: nextConnections };
	}, signal);
}

export async function addSyncSetup(name: string, setup: SyncSetupSettings, signal?: AbortSignal) {
	validateConfigName(name, "sync setup");
	await updateSettings((settings) => {
		if (Object.hasOwn(settings.syncSetups, name))
			throw new Error(`Sync setup already exists: ${name}`);
		if (!Object.hasOwn(settings.storageConnections, setup.storage.connection)) {
			throw new Error(`Storage connection not found: ${setup.storage.connection}`);
		}
		const nextSetups = { ...settings.syncSetups, [name]: structuredClone(setup) };
		assertUniqueLocations(nextSetups, settings.storageConnections);
		return {
			...settings,
			syncSetups: nextSetups,
			...(settings.activeSyncSetup ? {} : { activeSyncSetup: name }),
		};
	}, signal);
}

export async function updateSyncSetup(
	name: string,
	update: (setup: SyncSetupSettings) => SyncSetupSettings,
	options: {
		expectedStorage?: SyncSetupStorageReview;
		expectedInclude?: readonly string[];
		signal?: AbortSignal;
	} = {},
) {
	validateConfigName(name, "sync setup");
	await updateSettings((settings) => {
		const setup = settings.syncSetups[name];
		if (!setup) throw new Error(`Sync setup not found: ${name}`);
		if (
			options.expectedInclude &&
			!sameNames(normalizeSyncInclude(setup.sync.include), options.expectedInclude)
		) {
			throw new SyncSetupReviewChangedError(
				`Sync setup “${name}” included content changed while it was open; reopen it and review the current selection.`,
			);
		}
		if (options.expectedStorage) {
			const connectionName = setup.storage.connection;
			const connection = settings.storageConnections[connectionName];
			if (
				!connection ||
				!sameStorageReview(
					syncSetupStorageReview(name, setup, connectionName, connection),
					options.expectedStorage,
				)
			) {
				throw new SyncSetupReviewChangedError(
					`Sync setup “${name}” storage changed while it was open; reopen it and review the current storage location.`,
				);
			}
		}
		const nextSetup = update(structuredClone(setup));
		if (!Object.hasOwn(settings.storageConnections, nextSetup.storage.connection)) {
			throw new Error(`Storage connection not found: ${nextSetup.storage.connection}`);
		}
		const nextSetups = { ...settings.syncSetups, [name]: nextSetup };
		assertUniqueLocations(nextSetups, settings.storageConnections);
		return { ...settings, syncSetups: nextSetups };
	}, options.signal);
}

export async function removeSyncSetup(name: string, signal?: AbortSignal) {
	validateConfigName(name, "sync setup");
	await updateSettings((settings) => {
		if (!Object.hasOwn(settings.syncSetups, name)) throw new Error(`Sync setup not found: ${name}`);
		const isCurrent = settings.activeSyncSetup === name;
		if (isCurrent && Object.keys(settings.syncSetups).length > 1) {
			throw new Error("Switch to another sync setup before removing the current setup.");
		}
		const syncSetups = { ...settings.syncSetups };
		delete syncSetups[name];
		const next = { ...settings, syncSetups };
		if (isCurrent) delete next.activeSyncSetup;
		return next;
	}, signal);
}

export async function removeStorageConnection(name: string, signal?: AbortSignal) {
	validateConfigName(name, "storage connection");
	await updateSettings((settings) => {
		const referenced = referencingSetupNames(settings.syncSetups, name)[0];
		if (referenced) {
			throw new Error(`Storage connection “${name}” is used by sync setup “${referenced}”.`);
		}
		if (!Object.hasOwn(settings.storageConnections, name)) {
			throw new Error(`Storage connection not found: ${name}`);
		}
		const storageConnections = { ...settings.storageConnections };
		delete storageConnections[name];
		return { ...settings, storageConnections };
	}, signal);
}

async function updateSettings(
	update: (settings: PiSyncSettingsV3) => PiSyncSettingsV3,
	signal?: AbortSignal,
) {
	return updateLocalConfig((settings) => {
		if (settings.version !== 3) {
			throw new Error("Storage connections and sync setups require version 3 pi-sync settings.");
		}
		return update(settings);
	}, signal);
}

function referencingSetupNames(setups: Record<string, SyncSetupSettings>, connection: string) {
	return Object.entries(setups)
		.filter(([, setup]) => setup.storage.connection === connection)
		.map(([name]) => name)
		.sort((left, right) => left.localeCompare(right));
}

function assertUniqueLocations(
	setups: Record<string, SyncSetupSettings>,
	connections: Record<string, StorageConnectionSettings>,
) {
	const identities = new Map<string, string>();
	for (const [name, setup] of Object.entries(setups)) {
		const connection = connections[setup.storage.connection];
		if (!connection) throw new Error(`Storage connection not found: ${setup.storage.connection}`);
		const identity = effectiveSyncSetupRemoteIdentity(setup, connection);
		const previous = identities.get(identity);
		if (previous) {
			throw new Error(`Sync setup “${name}” duplicates the storage location of “${previous}”.`);
		}
		identities.set(identity, name);
	}
}

function sameNames(left: readonly string[], right: readonly string[]) {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

function sameStorageReview(left: SyncSetupStorageReview, right: SyncSetupStorageReview) {
	return (
		left.connectionName === right.connectionName &&
		left.storageKind === right.storageKind &&
		left.storagePath === right.storagePath &&
		left.bucket === right.bucket &&
		left.branch === right.branch
	);
}
