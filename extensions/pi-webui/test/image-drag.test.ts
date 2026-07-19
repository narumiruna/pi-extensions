import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const drag = (await import(
	`${pathToFileURL(path.join(process.cwd(), "extensions/pi-webui/src/web/image-drag.js")).href}?t=${Date.now()}`
)) as {
	dropAfterTarget(
		event: { clientX: number; clientY: number },
		item: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } },
		vertical: boolean,
	): boolean;
	imagesStackVertically(items: Array<{ offsetTop: number }>): boolean;
};

const item = {
	getBoundingClientRect: () => ({ left: 20, top: 40, width: 200, height: 80 }),
};

test("drop placement follows the pointer half on the active layout axis", () => {
	assert.equal(drag.dropAfterTarget({ clientX: 119, clientY: 79 }, item, false), false);
	assert.equal(drag.dropAfterTarget({ clientX: 120, clientY: 79 }, item, false), true);
	assert.equal(drag.dropAfterTarget({ clientX: 119, clientY: 79 }, item, true), false);
	assert.equal(drag.dropAfterTarget({ clientX: 119, clientY: 80 }, item, true), true);
});

test("drop feedback uses vertical placement only when every card occupies its own row", () => {
	assert.equal(drag.imagesStackVertically([{ offsetTop: 0 }, { offsetTop: 0 }]), false);
	assert.equal(drag.imagesStackVertically([{ offsetTop: 0 }, { offsetTop: 90 }]), true);
	assert.equal(
		drag.imagesStackVertically([{ offsetTop: 0 }, { offsetTop: 90 }, { offsetTop: 91 }]),
		false,
	);
});
