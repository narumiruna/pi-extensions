import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface LocalSkillSource {
	kind: "local";
	original: string;
	localPath: string;
	selector?: string;
}

export interface GitSkillSource {
	kind: "git";
	original: string;
	repository: string;
	ref?: string;
	subpath?: string;
	selector?: string;
	sshFallback?: string;
}

export type ParsedSkillSource = LocalSkillSource | GitSkillSource;

export function parseSkillSource(input: string, cwd: string): ParsedSkillSource {
	const original = input.trim();
	if (!original || containsUnsafeText(original)) throw new Error("Invalid skill source.");

	if (isLocalSource(original)) {
		return {
			kind: "local",
			original,
			localPath: resolve(cwd, expandTilde(original)),
		};
	}

	const shorthand = original.match(/^([^/@:\s]+)\/([^/@\s]+?)(?:@([^\s]+))?$/u);
	if (shorthand) {
		const [, owner, repository, selector] = shorthand;
		validateSelector(selector);
		return {
			kind: "git",
			original,
			repository: `https://github.com/${owner}/${stripGitSuffix(repository)}.git`,
			...(selector === undefined ? {} : { selector }),
			sshFallback: `git@github.com:${owner}/${stripGitSuffix(repository)}.git`,
		};
	}

	if (/^[^@\s]+@[^:\s]+:[^\s]+$/u.test(original)) {
		return { kind: "git", original, repository: original };
	}

	if (/(?:^|\/)(?:\.\.|%2e%2e)(?:\/|$)/iu.test(original)) {
		throw new Error("Unsafe repository path in skill source URL.");
	}
	let url: URL;
	try {
		url = new URL(original);
	} catch {
		throw new Error(`Unsupported skill source: ${original}`);
	}
	if (url.password || (url.protocol === "https:" && url.username)) {
		throw new Error("Credentials must not be embedded in a skill source URL.");
	}
	if (url.search || url.hash)
		throw new Error("Skill source URLs cannot contain query strings or fragments.");
	if (url.protocol !== "https:" && url.protocol !== "ssh:") {
		throw new Error(`Unsupported Git protocol: ${url.protocol}`);
	}
	if (url.protocol === "ssh:") return { kind: "git", original, repository: original };

	if (url.hostname.toLowerCase() === "github.com") return parseGitHubUrl(original, url);
	if (url.hostname.toLowerCase() === "gitlab.com") return parseGitLabUrl(original, url);
	return { kind: "git", original, repository: original };
}

export function resolveSkillSelector(
	source: ParsedSkillSource,
	optionSelector?: string,
): string | undefined {
	validateSelector(optionSelector);
	if (
		source.selector &&
		optionSelector &&
		source.selector.toLowerCase() !== optionSelector.toLowerCase()
	) {
		throw new Error(
			`Conflicting skill selectors: source selects "${source.selector}" but --skill selects "${optionSelector}".`,
		);
	}
	return optionSelector ?? source.selector;
}

export function normalizeSubpath(value: string): string {
	const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
	if (!normalized) return "";
	const segments = normalized.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error(`Unsafe repository subpath: ${value}`);
	}
	if (segments.some((segment) => containsUnsafeText(segment))) {
		throw new Error("Repository subpath contains terminal control characters.");
	}
	return segments.join("/");
}

function parseGitHubUrl(original: string, url: URL): GitSkillSource {
	const segments = decodePathSegments(url);
	if (segments.length < 2) throw new Error(`Invalid GitHub repository URL: ${original}`);
	const [owner, rawRepository, marker, rawRef, ...subpathParts] = segments;
	const repositoryName = stripGitSuffix(rawRepository);
	const base = `https://${url.host}/${owner}/${repositoryName}.git`;
	const result: GitSkillSource = {
		kind: "git",
		original,
		repository: base,
		sshFallback: `git@${url.host}:${owner}/${repositoryName}.git`,
	};
	if (segments.length === 2) return result;
	if (marker !== "tree" || !rawRef)
		throw new Error(`Unsupported GitHub repository URL: ${original}`);
	result.ref = validateRef(rawRef);
	const subpath = normalizeSubpath(subpathParts.join("/"));
	if (subpath) result.subpath = subpath;
	return result;
}

function parseGitLabUrl(original: string, url: URL): GitSkillSource {
	const segments = decodePathSegments(url);
	const markerIndex = segments.findIndex(
		(segment, index) => segment === "-" && segments[index + 1] === "tree",
	);
	const repositoryParts = markerIndex >= 0 ? segments.slice(0, markerIndex) : segments;
	if (repositoryParts.length < 2) throw new Error(`Invalid GitLab repository URL: ${original}`);
	repositoryParts[repositoryParts.length - 1] = stripGitSuffix(repositoryParts.at(-1) ?? "");
	const result: GitSkillSource = {
		kind: "git",
		original,
		repository: `https://${url.host}/${repositoryParts.join("/")}.git`,
		sshFallback: `git@${url.hostname}:${repositoryParts.join("/")}.git`,
	};
	if (markerIndex < 0) return result;
	const rawRef = segments[markerIndex + 2];
	if (!rawRef) throw new Error(`Invalid GitLab tree URL: ${original}`);
	result.ref = validateRef(rawRef);
	const subpath = normalizeSubpath(segments.slice(markerIndex + 3).join("/"));
	if (subpath) result.subpath = subpath;
	return result;
}

function decodePathSegments(url: URL): string[] {
	return url.pathname
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			let decoded: string;
			try {
				decoded = decodeURIComponent(segment);
			} catch {
				throw new Error(`Invalid URL path encoding: ${url.pathname}`);
			}
			if (decoded.includes("/") || decoded.includes("\\") || containsUnsafeText(decoded)) {
				throw new Error(`Unsafe URL path segment: ${segment}`);
			}
			return decoded;
		});
}

function validateRef(ref: string): string {
	if (
		!ref ||
		ref.startsWith("-") ||
		ref.endsWith("/") ||
		ref.includes("..") ||
		ref.includes("//") ||
		ref.includes("@{") ||
		/\s/u.test(ref) ||
		["~", "^", ":", "?", "*", "[", "\\"].some((character) => ref.includes(character)) ||
		containsUnsafeText(ref)
	) {
		throw new Error(`Unsafe Git ref: ${ref}`);
	}
	return ref;
}

function validateSelector(selector: string | undefined): void {
	if (selector === undefined) return;
	if (!selector || containsUnsafeText(selector) || selector.startsWith("-")) {
		throw new Error(`Invalid skill selector: ${selector}`);
	}
}

function isLocalSource(input: string): boolean {
	return (
		isAbsolute(input) ||
		input === "." ||
		input === ".." ||
		input === "~" ||
		input.startsWith("./") ||
		input.startsWith("../") ||
		input.startsWith(".\\") ||
		input.startsWith("..\\") ||
		input.startsWith("~/") ||
		input.startsWith("~\\") ||
		input.startsWith("\\\\") ||
		/^[A-Za-z]:[/\\]/u.test(input)
	);
}

function expandTilde(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) return `${homedir()}${input.slice(1)}`;
	return input;
}

function stripGitSuffix(value: string): string {
	return value.replace(/\.git$/iu, "");
}

function containsUnsafeText(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return (
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			(codePoint >= 0x202a && codePoint <= 0x202e) ||
			(codePoint >= 0x2066 && codePoint <= 0x2069)
		);
	});
}
