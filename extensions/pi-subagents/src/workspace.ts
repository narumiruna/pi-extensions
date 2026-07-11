import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface IsolatedWorkspace {
	mode: "worktree";
	path: string;
	originalCwd: string;
}

export class WorkspaceManager {
	private readonly owned = new Map<string, IsolatedWorkspace>();

	async create(ownerId: string, cwd: string): Promise<IsolatedWorkspace> {
		const root = (await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
		const status = (await execFileAsync("git", ["-C", root, "status", "--porcelain"])).stdout;
		if (status.trim()) throw new Error("Isolated subagent workspace requires a clean Git repository");
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-worktree-"));
		try {
			await execFileAsync("git", ["-C", root, "worktree", "add", "--detach", dir, "HEAD"]);
			await fs.promises.writeFile(`${dir}.owner`, ownerId, { mode: 0o600 });
			const workspace = { mode: "worktree" as const, path: dir, originalCwd: root };
			this.owned.set(ownerId, workspace);
			return workspace;
		} catch (error) {
			await fs.promises.rm(dir, { recursive: true, force: true });
			throw error;
		}
	}

	async cleanup(ownerId: string): Promise<void> {
		const workspace = this.owned.get(ownerId);
		if (!workspace) return;
		this.owned.delete(ownerId);
		if (!(await this.isOwned(workspace.path, ownerId))) return;
		await execFileAsync("git", ["-C", workspace.originalCwd, "worktree", "remove", "--force", workspace.path])
			.catch(async () => fs.promises.rm(workspace.path, { recursive: true, force: true }));
		await fs.promises.rm(`${workspace.path}.owner`, { force: true });
	}

	async cleanupAll(): Promise<void> {
		await Promise.all([...this.owned.keys()].map((ownerId) => this.cleanup(ownerId)));
	}

	private async isOwned(workspacePath: string, ownerId: string): Promise<boolean> {
		if (!path.basename(workspacePath).startsWith("pi-subagent-worktree-")) return false;
		try {
			return (await fs.promises.readFile(`${workspacePath}.owner`, "utf8")) === ownerId;
		} catch {
			return false;
		}
	}
}
