import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WORKTREE_PREFIX = "pi-subagent-worktree-";

export interface IsolatedWorkspace {
	mode: "worktree";
	path: string;
	rootPath: string;
	repositoryRoot: string;
}

export class WorkspaceManager {
	private readonly owned = new Map<string, IsolatedWorkspace>();

	async create(ownerId: string, cwd: string): Promise<IsolatedWorkspace> {
		if (this.owned.has(ownerId)) throw new Error(`Workspace owner already exists: ${ownerId}`);
		const resolvedCwd = path.resolve(cwd);
		const repositoryRoot = (
			await execFileAsync("git", ["-C", resolvedCwd, "rev-parse", "--show-toplevel"])
		).stdout.trim();
		const relativeCwd = path.relative(repositoryRoot, resolvedCwd);
		if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
			throw new Error("Subagent cwd is outside the Git repository");
		}
		const status = (
			await execFileAsync("git", ["-C", repositoryRoot, "status", "--porcelain"])
		).stdout;
		if (status.trim()) throw new Error("Isolated subagent workspace requires a clean Git repository");
		const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), WORKTREE_PREFIX));
		let registered = false;
		try {
			await execFileAsync("git", [
				"-C",
				repositoryRoot,
				"worktree",
				"add",
				"--detach",
				rootPath,
				"HEAD",
			]);
			registered = true;
			await fs.promises.writeFile(`${rootPath}.owner`, ownerId, { mode: 0o600 });
			const workspace = {
				mode: "worktree" as const,
				path: path.join(rootPath, relativeCwd),
				rootPath,
				repositoryRoot,
			};
			this.owned.set(ownerId, workspace);
			return workspace;
		} catch (error) {
			if (registered) {
				await execFileAsync("git", [
					"-C",
					repositoryRoot,
					"worktree",
					"remove",
					"--force",
					rootPath,
				]).catch(() => undefined);
			}
			await fs.promises.rm(rootPath, { recursive: true, force: true });
			await fs.promises.rm(`${rootPath}.owner`, { force: true });
			throw error;
		}
	}

	async cleanup(ownerId: string): Promise<void> {
		const workspace = this.owned.get(ownerId);
		if (!workspace) return;
		if (!(await this.isOwned(workspace.rootPath, ownerId))) {
			throw new Error(`Refusing to clean unowned subagent workspace: ${workspace.rootPath}`);
		}
		this.owned.delete(ownerId);
		await execFileAsync("git", [
			"-C",
			workspace.repositoryRoot,
			"worktree",
			"remove",
			"--force",
			workspace.rootPath,
		]).catch(async () => {
			await fs.promises.rm(workspace.rootPath, { recursive: true, force: true });
			await execFileAsync("git", ["-C", workspace.repositoryRoot, "worktree", "prune"])
				.catch(() => undefined);
		});
		await fs.promises.rm(`${workspace.rootPath}.owner`, { force: true });
	}

	async cleanupAll(): Promise<void> {
		const results = await Promise.allSettled(
			[...this.owned.keys()].map((ownerId) => this.cleanup(ownerId)),
		);
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length > 0) {
			throw new AggregateError(
				failures.map((failure) => (failure as PromiseRejectedResult).reason),
				`Failed to clean ${failures.length} subagent workspace(s)`,
			);
		}
	}

	private async isOwned(rootPath: string, ownerId: string): Promise<boolean> {
		if (!path.basename(rootPath).startsWith(WORKTREE_PREFIX)) return false;
		try {
			return (await fs.promises.readFile(`${rootPath}.owner`, "utf8")) === ownerId;
		} catch {
			return false;
		}
	}
}
