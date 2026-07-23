const GOAL_PROMPT_MARKER_PREFIX = "pi-goal-prompt:";
const CONTINUATION_MARKER_PREFIX = "pi-goal-continuation:";

const GOAL_PROMPT_MARKER_PATTERN = new RegExp(
	`<!--\\s*${escapeRegExpText(GOAL_PROMPT_MARKER_PREFIX)}([^\\s>]+)\\s*-->`,
);
const CONTINUATION_MARKER_PATTERN = new RegExp(
	`<!--\\s*${escapeRegExpText(CONTINUATION_MARKER_PREFIX)}([^\\s>]+)\\s*-->`,
);

export function extractGoalPromptMarker(prompt: string) {
	return GOAL_PROMPT_MARKER_PATTERN.exec(prompt)?.[1];
}

export function extractContinuationMarker(prompt: string) {
	return CONTINUATION_MARKER_PATTERN.exec(prompt)?.[1];
}

export function appendGoalPromptMarker(prompt: string, marker: string) {
	return `${prompt}\n\n<!-- ${GOAL_PROMPT_MARKER_PREFIX}${marker} -->`;
}

function escapeRegExpText(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
