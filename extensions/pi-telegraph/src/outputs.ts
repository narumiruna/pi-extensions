import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories = new Set<string>();

export async function saveTemporaryOutput(content: string, extension: ".md" | ".json") {
	const directory = await mkdtemp(join(tmpdir(), "pi-telegraph-"));
	temporaryDirectories.add(directory);
	try {
		await chmod(directory, 0o700);
		const filePath = join(directory, `page${extension}`);
		await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
		await chmod(filePath, 0o600);
		return filePath;
	} catch (error) {
		temporaryDirectories.delete(directory);
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

export async function cleanupTemporaryOutputs() {
	const directories = [...temporaryDirectories];
	for (const directory of directories) temporaryDirectories.delete(directory);
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { recursive: true, force: true }).catch(() => undefined),
		),
	);
}
