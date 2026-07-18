import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const webRoot = path.join(process.cwd(), "extensions/pi-image-drop/src/web");
const [html, app, styles] = await Promise.all(
	["index.html", "app.js", "styles.css"].map((file) => readFile(path.join(webRoot, file), "utf8")),
);

test("web page presents one shared metadata-removal guarantee", () => {
	assert.equal(
		[html, app].join("\n").match(/Sensitive image metadata removed/g)?.length,
		1,
		"the exact shared notice should appear once in page source",
	);
	assert.match(html, /class="collection-note"/);
	assert.equal(
		app.match(/visibleItemNotes\(item\.notes\)/g)?.length,
		2,
		"draft and history cards should use the exact-note filter",
	);
});

test("history controls and retention details share one contextual header", () => {
	assert.match(
		html,
		/<header class="history-toolbar">[\s\S]*id="history-title"[\s\S]*id="history-status"[\s\S]*id="history-retention"[\s\S]*id="clear-history"[\s\S]*<\/header>/,
	);
	assert.match(styles, /\.history-toolbar\s*\{[\s\S]*justify-content:\s*flex-start/);
});

test("image grids collapse unused tracks and bound a lone wide card", () => {
	assert.match(
		styles,
		/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*245px\),\s*1fr\)\)/,
	);
	assert.doesNotMatch(styles, /grid-template-columns:\s*repeat\(auto-fill/);
	assert.match(styles, /\.image-card:only-child\s*\{[\s\S]*max-width:/);
});

test("visible action labels preserve selection, re-staging, and confirmed destructive paths", () => {
	for (const label of ["Choose images", "Add again", "Clear all", "Clear history", "Delete"]) {
		assert.match(`${html}\n${app}`, new RegExp(`>${label}<|["']${label}["']`));
	}
	assert.equal((html.match(/<dialog/g) ?? []).length, 3);
	assert.match(styles, /button\s*\{[\s\S]*min-height:\s*44px/);
	assert.match(styles, /button:focus-visible/);
});
