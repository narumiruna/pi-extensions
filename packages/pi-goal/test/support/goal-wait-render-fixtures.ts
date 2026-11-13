export const WAIT_GOAL_ID = "64c2162c-9a8a-4911-bd66-f679aa0cc6e9";
export const WAIT_REASON =
  "The unchanged mandatory workspace runner is in progress on the final review-fix code. Monitor job_mwenzczj_3h will wake this session on success or failure. Commit, publication and thread resolution depend on that result.";
export const WAIT_DEADLINE = Date.parse("2026-11-13T07:55:00.000Z");

const details = { goal: "Verify the workspace", goal_id: WAIT_GOAL_ID, reason: WAIT_REASON };

export const waitRenderFixtures = [
  {
    name: "accepted without a deadline",
    result: { content: [{ type: "text", text: `Goal waiting: ${WAIT_REASON}` }], details },
    accepted: true,
    expected: WAIT_REASON,
  },
  {
    name: "accepted with a deadline",
    result: {
      content: [{ type: "text", text: `Goal waiting: ${WAIT_REASON}` }],
      details: { ...details, resume_after_ms: 300_000, resume_at: WAIT_DEADLINE },
    },
    accepted: true,
    expected: WAIT_REASON,
  },
  {
    name: "accepted with a clamped deadline",
    result: {
      content: [
        { type: "text", text: `Goal waiting: ${WAIT_REASON}\nRequested resume_after_ms 1 was clamped to 10000.` },
      ],
      details: { ...details, requested_resume_after_ms: 1, resume_after_ms: 10_000, resume_at: WAIT_DEADLINE },
    },
    accepted: true,
    expected: WAIT_REASON,
  },
  {
    name: "rejected despite populated wait details",
    result: {
      content: [{ type: "text", text: "goal_wait rejected: goal_id does not match the active goal." }],
      details,
    },
    accepted: false,
    expected: "goal_wait rejected: goal_id does not match the active goal.",
  },
  {
    name: "legacy result without details",
    result: { content: [{ type: "text", text: "Goal waiting: legacy reason and deadline information" }] },
    accepted: false,
    expected: "Goal waiting: legacy reason and deadline information",
  },
  {
    name: "legacy result with incomplete details",
    result: {
      content: [{ type: "text", text: "Goal waiting: retain the original diagnostic text" }],
      details: { reason: "Do not replace the original result" },
    },
    accepted: false,
    expected: "Goal waiting: retain the original diagnostic text",
  },
  {
    name: "unknown result",
    result: { content: [{ type: "text", text: "Unrecognized historical wait result" }], details },
    accepted: false,
    expected: "Unrecognized historical wait result",
  },
];
