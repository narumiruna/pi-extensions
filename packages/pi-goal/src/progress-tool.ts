import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyRequirementUpdates, MAX_REQUIREMENTS, requirementReviewLines } from "./progress.js";
import { type GoalRuntime, goalIdRejectionReason, MAX_GOAL_ID_LENGTH } from "./runtime.js";

export function registerGoalProgressTool(pi: ExtensionAPI, runtime: GoalRuntime) {
	pi.registerTool({
		name: "goal_progress",
		label: "Goal Progress",
		description:
			"Read or add/update the active Goal requirement/evidence checklist using its current goal_id. Omit requirements to read. Updates are additive by immutable id/text; nothing is removed. Verified items require concrete evidence, not just assertions. Once recorded, all items must be verified before goal_complete. Agent-reported evidence is not independent proof. Output is bounded to 50 KB/2,000 lines. Tool visibility alone does not activate Goal mode.",
		parameters: Type.Object({
			goal_id: Type.String({ minLength: 1, maxLength: MAX_GOAL_ID_LENGTH }),
			requirements: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String({ minLength: 1, maxLength: 64 }),
						text: Type.String({ minLength: 1, maxLength: 500 }),
						status: StringEnum(["unverified", "verified", "blocked"] as const),
						evidence: Type.String({
							maxLength: 1_000,
							description:
								"Command and observed result or artifact/location and what it proves; empty when no evidence exists.",
						}),
					}),
					{ maxItems: MAX_REQUIREMENTS },
				),
			),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (signal?.aborted) throw new Error("Goal progress cancelled.");
			const goal = runtime.activeGoal;
			if (
				goal?.status !== "active" ||
				!runtime.ownsWorkflow(goal) ||
				!runtime.canRecordGoalUsage()
			) {
				throw new Error("Goal progress requires the current run to own an active Goal.");
			}
			const rejection = goalIdRejectionReason(
				goal,
				typeof params.goal_id === "string" ? params.goal_id.trim() : "",
			);
			if (rejection) throw new Error(`Goal progress rejected: ${rejection}.`);
			const requirements = applyRequirementUpdates(goal.requirements, params.requirements ?? []);
			if (params.requirements?.length) {
				runtime.activeGoal = { ...goal, requirements, updatedAt: Date.now() };
				runtime.persistGoal(runtime.activeGoal);
				runtime.updateStatus(ctx, runtime.activeGoal);
			}
			const notice = "\n[Checklist display truncated; full state remains in details.]";
			const output = truncateHead(requirementReviewLines(requirements).join("\n"), {
				maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice),
				maxLines: DEFAULT_MAX_LINES - 1,
			});
			return {
				content: [{ type: "text", text: output.content + (output.truncated ? notice : "") }],
				details: { goal_id: goal.id, requirements },
			};
		},
	});
}
