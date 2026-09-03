import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
	loadConfig,
	localConfigPath,
	readStateForConfig,
	statePathForConfig,
} from "../src/config.js";
import { expectedRemoteHead } from "../src/sync-backend.js";
import {
	diff,
	doctor,
	history,
	PublicationStatePersistenceError,
	pull,
	push,
	RollbackPublicationError,
	rollback,
	status,
	syncBoth,
} from "../src/sync-operations.js";
import type { CommandOptions, Snapshot, SyncConfig } from "../src/types.js";
import { v3S3Settings as requiredConfig, snapshot, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

test("fake backend exercises push, pull, history, rollback, and revision state", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const backend = new MemorySyncBackend();
		const factory = () => backend;
		const { ctx, notifications } = createMockContext({ hasUI: true });
		const config = await loadConfig();

		await push(ctx, commandOptions(), undefined, factory);
		const pushed = await backend.readHead();
		assert.ok(pushed);
		assert.equal((await readStateForConfig(config)).lastRemoteRevision, pushed.revision);
		const pushedSnapshot = await backend.readSnapshot(pushed.snapshotRef);
		const revisionOnly = await backend.publishSnapshot(pushedSnapshot, expectedRemoteHead(pushed));
		await status(ctx, commandOptions(), factory);
		assert.match(notifications.at(-1)?.message ?? "", /remote changed since last sync: yes/);
		await syncBoth(ctx, commandOptions(), factory);
		assert.equal((await readStateForConfig(config)).lastRemoteRevision, revisionOnly.head.revision);

		const remote = {
			...snapshot([{ path: "settings.json", content: Buffer.from('{"remote":true}\n') }]),
			id: "remote-change",
		};
		const remoteResult = await backend.publishSnapshot(
			remote,
			expectedRemoteHead(revisionOnly.head),
		);
		await pull(ctx, commandOptions(), factory);
		assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"remote":true}\n');
		assert.equal((await readStateForConfig(config)).lastRemoteRevision, remoteResult.head.revision);

		await history(ctx, commandOptions(), factory);
		assert.match(notifications.map((item) => item.message).join("\n"), /remote-change/);

		await rollback(ctx, { ...commandOptions(), args: [pushed.snapshotRef] }, factory);
		const restoredHead = await backend.readHead();
		assert.ok(restoredHead);
		assert.notEqual(restoredHead.snapshotRef, pushed.snapshotRef);
		assert.notEqual(restoredHead.revision, pushed.revision);
		assert.deepEqual(
			(await backend.listHistory()).map((entry) => entry.snapshotId),
			[pushed.snapshotId, remote.id, restoredHead.snapshotId],
		);
		assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"local":true}\n');
		assert.equal((await readStateForConfig(config)).lastRemoteRevision, restoredHead.revision);
	});
});

test("history rollback aborts if the selected backend destination changes", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"current":true}\n');
		const initialSettings = v3SettingsWithBucket("first-bucket");
		writeFileSync(localConfigPath(), JSON.stringify(initialSettings));
		const first = new MemorySyncBackend("memory:first", "memory · first");
		const second = new MemorySyncBackend("memory:second", "memory · second");
		const historical = {
			...snapshot([{ path: "settings.json", content: Buffer.from('{"historical":true}\n') }]),
			id: "historical",
		};
		await first.publishSnapshot(historical, { kind: "missing" });
		const current = {
			...snapshot([{ path: "settings.json", content: Buffer.from('{"current":true}\n') }]),
			id: "current",
		};
		await first.publishSnapshot(current, expectedRemoteHead(await first.readHead()));
		const factory = (config: SyncConfig) =>
			config.backend.destination.bucket === "first-bucket" ? first : second;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async (_title: string, options: string[]) => {
				writeFileSync(localConfigPath(), JSON.stringify(v3SettingsWithBucket("second-bucket")));
				return options[0];
			},
		});

		await assert.rejects(history(ctx, commandOptions(), factory), /storage location changed/i);
		assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"current":true}\n');
		assert.equal((await first.readHead())?.snapshotId, current.id);
		assert.equal(await second.readHead(), undefined);
	});
});

test("rollback reports a typed local/remote partial failure with its backup", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"current":true}\n');
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const backend = new ConflictingRollbackBackend();
		const historical = {
			...snapshot([{ path: "settings.json", content: Buffer.from('{"historical":true}\n') }]),
			id: "historical",
		};
		await backend.publishSnapshot(historical, { kind: "missing" });
		const current = {
			...snapshot([{ path: "settings.json", content: Buffer.from('{"current":true}\n') }]),
			id: "current",
		};
		await backend.publishSnapshot(current, expectedRemoteHead(await backend.readHead()));
		backend.failRollbackPublication = true;
		const { ctx } = createMockContext({ hasUI: true });

		await assert.rejects(
			rollback(ctx, { ...commandOptions(), args: [historical.id] }, () => backend),
			(error: unknown) => {
				assert.ok(error instanceof RollbackPublicationError);
				assert.equal(existsSync(error.backupPath), true);
				assert.match(error.message, /applied locally.*remote publication failed/i);
				return true;
			},
		);
		assert.equal(
			readFileSync(path.join(agentDir, "settings.json"), "utf8"),
			'{"historical":true}\n',
		);
		assert.equal((await backend.readHead())?.snapshotId, "concurrent");
	});
});

test("rollback rejects a remote head change that lands during confirmation", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"current":true}\n');
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const backend = new MemorySyncBackend();
		const historical = {
			...snapshot([{ path: "settings.json", content: Buffer.from('{"historical":true}\n') }]),
			id: "historical",
		};
		await backend.publishSnapshot(historical, { kind: "missing" });
		const current = {
			...snapshot([{ path: "settings.json", content: Buffer.from('{"current":true}\n') }]),
			id: "current",
		};
		await backend.publishSnapshot(current, expectedRemoteHead(await backend.readHead()));
		const concurrent = {
			...snapshot([{ path: "settings.json", content: Buffer.from('{"concurrent":true}\n') }]),
			id: "concurrent",
		};
		const { ctx } = createMockContext({
			hasUI: true,
			confirm: async () => {
				await backend.publishSnapshot(concurrent, expectedRemoteHead(await backend.readHead()));
				return true;
			},
		});

		await assert.rejects(
			rollback(ctx, { ...commandOptions(), args: [historical.id], yes: false }, () => backend),
			RollbackPublicationError,
		);
		assert.equal((await backend.readHead())?.snapshotId, concurrent.id);
	});
});

test("push reports a typed partial outcome when remote commits but local state cannot persist", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const config = await loadConfig();
		const backend = new StateBreakingBackend(statePathForConfig(config));
		const { ctx } = createMockContext({ hasUI: true });

		await assert.rejects(
			push(ctx, commandOptions(), undefined, () => backend),
			(error: unknown) => {
				assert.ok(error instanceof PublicationStatePersistenceError);
				assert.match(error.message, /remote publication.*active.*state could not be saved/i);
				return true;
			},
		);
		assert.ok(await backend.readHead());
	});
});

test("global setting skips push secret blocking but keeps doctor scanning", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			'{"OPENAI_API_KEY":"sk-123456789012345678901234567890"}\n',
		);
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const blockedBackend = new MemorySyncBackend();
		const { ctx } = createMockContext({ hasUI: true });
		await assert.rejects(
			push(ctx, commandOptions(), undefined, () => blockedBackend),
			/Refusing to push possible secrets/u,
		);
		assert.equal(await blockedBackend.readHead(), undefined);

		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig({ skipSecretScan: true })));
		const allowedBackend = new MemorySyncBackend();
		const allowed = createMockContext({ hasUI: true });
		await push(allowed.ctx, commandOptions(), undefined, () => allowedBackend);
		assert.ok(await allowedBackend.readHead());
		await doctor(allowed.ctx, commandOptions(), () => allowedBackend);
		assert.match(allowed.notifications.at(-1)?.message ?? "", /possible secrets found/u);
	});
});

test("fake backend exercises status, diff, sync, and backend diagnostics", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const backend = new MemorySyncBackend();
		const factory = () => backend;
		const { ctx, notifications } = createMockContext({ hasUI: true });

		await status(ctx, commandOptions(), factory);
		await diff(ctx, commandOptions(), factory);
		await syncBoth(ctx, commandOptions(), factory);
		await doctor(ctx, commandOptions(), factory);

		const output = notifications.map((item) => item.message).join("\n");
		assert.match(output, /remote: empty/);
		assert.match(output, /Remote is empty\. Local push would upload/);
		assert.match(output, /Pushed 1 files/);
		assert.match(output, /publication safety: atomic-conditional \(verified atomic precondition\)/);
		assert.match(output, /memory backend: ok/);
		const doctorOutput = notifications.at(-1)?.message ?? "";
		assert.ok(doctorOutput.indexOf("secret scan:") < doctorOutput.indexOf("storage location:"));
		assert.ok(doctorOutput.indexOf("lock:") < doctorOutput.indexOf("publication safety:"));
	});
});

test("forced fake-backend push re-reads the head and preserves newly observed unmanaged files", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const backend = new AdvancingMemoryBackend();
		const initial = {
			...snapshot([{ path: "settings.json", content: Buffer.from('{"initial":true}\n') }]),
			id: "initial",
		};
		await backend.publishSnapshot(initial, { kind: "missing" });
		backend.arm({
			...snapshot([
				{ path: "settings.json", content: Buffer.from('{"advanced":true}\n') },
				{ path: "AGENTS.md", content: Buffer.from("preserve me\n") },
			]),
			id: "advanced",
		});
		const { ctx } = createMockContext({ hasUI: true });

		await push(ctx, { ...commandOptions(), force: true }, undefined, () => backend);

		assert.ok(backend.readCount >= 2);
		const head = await backend.readHead();
		assert.ok(head);
		const published = await backend.readSnapshot(head.snapshotRef);
		assert.deepEqual(published.files.map((file) => file.path).sort(), [
			"AGENTS.md",
			"settings.json",
		]);
	});
});

class StateBreakingBackend extends MemorySyncBackend {
	constructor(private readonly statePath: string) {
		super();
	}

	override async publishSnapshot(
		snapshotValue: Snapshot,
		expected: Parameters<MemorySyncBackend["publishSnapshot"]>[1],
		options?: Parameters<MemorySyncBackend["publishSnapshot"]>[2],
	) {
		const result = await super.publishSnapshot(snapshotValue, expected, options);
		mkdirSync(this.statePath, { recursive: true });
		return result;
	}
}

class ConflictingRollbackBackend extends MemorySyncBackend {
	failRollbackPublication = false;

	override async publishSnapshot(
		snapshotValue: Snapshot,
		expected: Parameters<MemorySyncBackend["publishSnapshot"]>[1],
		options?: Parameters<MemorySyncBackend["publishSnapshot"]>[2],
	) {
		if (this.failRollbackPublication) {
			this.failRollbackPublication = false;
			const current = await super.readHead();
			await super.publishSnapshot(
				{ ...snapshotValue, id: "concurrent" },
				expectedRemoteHead(current),
			);
		}
		return super.publishSnapshot(snapshotValue, expected, options);
	}
}

class AdvancingMemoryBackend extends MemorySyncBackend {
	readCount = 0;
	private advanced?: Snapshot;

	arm(snapshotValue: Snapshot) {
		this.advanced = snapshotValue;
	}

	override async readHead(signal?: AbortSignal) {
		this.readCount += 1;
		if (this.readCount === 2 && this.advanced) {
			const current = await super.readHead(signal);
			await super.publishSnapshot(this.advanced, expectedRemoteHead(current), { signal });
			this.advanced = undefined;
		}
		return super.readHead(signal);
	}
}

function v3SettingsWithBucket(bucket: string) {
	const settings = requiredConfig();
	settings.syncSetups.home.storage.bucket = bucket;
	return settings;
}

function commandOptions(): CommandOptions {
	return {
		yes: true,
		force: false,
		stale: false,
		silent: false,
		reload: false,
		auto: false,
		args: [],
	};
}
