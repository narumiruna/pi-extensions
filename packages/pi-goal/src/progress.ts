import { safeGoalMenuText } from "./errors.js";

export const MAX_REQUIREMENTS = 32;
export interface GoalRequirement {
	id: string;
	text: string;
	status: "unverified" | "verified" | "blocked";
	evidence: string;
}

function parseRequirement(value: unknown): GoalRequirement {
	if (!value || typeof value !== "object") throw new Error("Invalid requirement.");
	const item = value as Record<string, unknown>;
	if (typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(item.id)) {
		throw new Error("Requirement id must be 1–64 letters, digits, dots, underscores, or hyphens.");
	}
	if (typeof item.text !== "string" || !item.text.trim() || item.text.length > 500) {
		throw new Error("Requirement text must contain 1–500 characters.");
	}
	if (item.status !== "verified" && item.status !== "unverified" && item.status !== "blocked") {
		throw new Error("Invalid requirement status.");
	}
	if (typeof item.evidence !== "string" || item.evidence.length > 1_000) {
		throw new Error("Requirement evidence must contain at most 1,000 characters.");
	}
	return {
		id: item.id,
		text: item.text.trim(),
		status: item.status,
		evidence: item.evidence.trim(),
	};
}

export function applyRequirementUpdates(
	current: readonly GoalRequirement[] | undefined,
	updates: unknown,
): GoalRequirement[] {
	if (!Array.isArray(updates) || updates.length > MAX_REQUIREMENTS) {
		throw new Error(`Provide at most ${MAX_REQUIREMENTS} requirement updates.`);
	}
	const next = new Map((current ?? []).map((item) => [item.id, { ...item }]));
	const seen = new Set<string>();
	for (const update of updates) {
		const item = parseRequirement(update);
		if (seen.has(item.id)) throw new Error("Duplicate requirement id in update.");
		seen.add(item.id);
		if (item.status === "verified" && !item.evidence) {
			throw new Error("Verified requirements need concrete evidence.");
		}
		const previous = next.get(item.id);
		if (previous && previous.text !== item.text) {
			throw new Error(
				"Requirement text cannot change; add a new requirement or edit the goal objective.",
			);
		}
		next.delete(item.id);
		next.set(item.id, item);
	}
	if (next.size > MAX_REQUIREMENTS)
		throw new Error(`A goal supports at most ${MAX_REQUIREMENTS} requirements.`);
	return [...next.values()];
}

export function normalizeRequirements(value: unknown): GoalRequirement[] | undefined {
	if (value === undefined) return undefined;
	// Preserve a completion barrier for damaged persisted checklists rather than silently dropping it.
	try {
		if (!Array.isArray(value) || value.length > MAX_REQUIREMENTS)
			throw new Error("Invalid checklist.");
		const seen = new Set<string>();
		return value.map((raw) => {
			const item = parseRequirement(raw);
			if (seen.has(item.id)) throw new Error("Duplicate requirement.");
			seen.add(item.id);
			return item.status === "verified" && !item.evidence
				? { ...item, status: "unverified" as const }
				: item;
		});
	} catch {
		return [
			{
				id: "checklist-recovery",
				text: "Reconstruct and verify the damaged requirement checklist from the full objective",
				status: "unverified",
				evidence: "",
			},
		];
	}
}

export function completionCoverageIssue(requirements: readonly GoalRequirement[] | undefined) {
	const pending = requirements?.filter(
		(item) => item.status !== "verified" || !item.evidence.trim(),
	);
	return pending?.length
		? `requirement coverage is incomplete (unverified or blocked): ${pending.map((item) => item.id).join(", ")}`
		: undefined;
}

export function requirementReviewLines(requirements: readonly GoalRequirement[] | undefined) {
	if (!requirements?.length)
		return [
			"Requirements: not recorded (completion still requires a full objective audit).",
			"Last recorded evidence: none.",
		];
	const verified = requirements.filter((item) => item.status === "verified").length;
	const latest = [...requirements].reverse().find((item) => item.evidence);
	return [
		`Requirements: ${verified}/${requirements.length} agent-reported verified · Remaining: ${requirements.length - verified}`,
		`Last recorded evidence: ${latest ? `${latest.id}: ${safeGoalMenuText(latest.evidence, 1_000)}` : "none"}`,
		"Checklist and evidence are agent-reported, not independently proven; recheck stale evidence.",
		...requirements.map(
			(item) =>
				`${item.id} [${item.status}]: ${safeGoalMenuText(item.text, 500)}${item.evidence ? ` — ${safeGoalMenuText(item.evidence, 1_000)}` : ""}`,
		),
	];
}
