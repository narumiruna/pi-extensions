import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, driveCustomSelector } from "../../../test/support.js";
import { showPersistentSelector } from "../src/selector-ui.js";

test("persistent selector retains toggle rows and resets after page changes", async () => {
	let page = 0;
	let renders: string[][] = [];
	const { ctx } = createMockContext({
		hasUI: true,
		custom: async (factory: unknown) => {
			const driven = driveCustomSelector(factory, [
				"tui.select.down",
				"tui.select.confirm",
				"tui.select.down",
				"tui.select.confirm",
				"tui.select.cancel",
			]);
			renders = driven.renders;
			return driven.result;
		},
	});

	const handled = await showPersistentSelector(
		ctx,
		() => ({
			title: `Page ${page + 1}`,
			rows:
				page === 0
					? [
							{ value: "first", label: "Page 1 first" },
							{ value: "next", label: "Next page" },
						]
					: [
							{ value: "second-first", label: "Page 2 first" },
							{ value: "second-second", label: "Page 2 second" },
						],
		}),
		(value) => {
			if (value === "next") {
				page = 1;
				return "reset";
			}
			return "stay";
		},
	);

	assert.equal(handled, true);
	assert.ok(renders[1]?.some((line) => line.includes("› Page 2 first")));
	assert.ok(renders[3]?.some((line) => line.includes("› Page 2 second")));
});
