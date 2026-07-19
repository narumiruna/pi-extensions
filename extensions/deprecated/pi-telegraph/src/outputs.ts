import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories = new WeakMap<object, Set<string>>();

export async function saveTemporaryOutput(
	owner: object,
	content: string,
	extension: ".md" | ".json",
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-telegraph-"));
	let directories = temporaryDirectories.get(owner);
	if (!directories) {
		directories = new Set();
		temporaryDirectories.set(owner, directories);
	}
	directories.add(directory);
	try {
		await chmod(directory, 0o700);
		const filePath = join(directory, `page${extension}`);
		await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
		await chmod(filePath, 0o600);
		return filePath;
	} catch (error) {
		directories.delete(directory);
		if (directories.size === 0) temporaryDirectories.delete(owner);
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

export async function cleanupTemporaryOutputs(owner: object) {
	const directories = temporaryDirectories.get(owner);
	if (!directories) return;
	temporaryDirectories.delete(owner);
	await Promise.all(
		[...directories].map((directory) =>
			rm(directory, { recursive: true, force: true }).catch(() => undefined),
		),
	);
}
