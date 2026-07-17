import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_CONTENT_BYTES,
	markdownToTelegraphNodes,
	telegraphNodesToMarkdown,
	validateTelegraphNodes,
} from "../src/content.js";

test("Markdown converts supported blocks and inline formatting to Telegraph nodes", () => {
	const nodes = markdownToTelegraphNodes(
		"# Title\n\nHello **bold** *em* ~~gone~~ [site](https://example.com).\n\n- [x] done\n- todo\n\n```ts\nconst x = 1;\n```",
	);

	assert.deepEqual(nodes[0], { tag: "h3", children: ["Title"] });
	assert.deepEqual(nodes[1], {
		tag: "p",
		children: [
			"Hello ",
			{ tag: "strong", children: ["bold"] },
			" ",
			{ tag: "em", children: ["em"] },
			" ",
			{ tag: "s", children: ["gone"] },
			" ",
			{ tag: "a", attrs: { href: "https://example.com" }, children: ["site"] },
			".",
		],
	});
	assert.deepEqual(nodes[2], {
		tag: "ul",
		children: [
			{ tag: "li", children: ["[x] done"] },
			{ tag: "li", children: ["todo"] },
		],
	});
	assert.deepEqual(nodes[3], { tag: "pre", children: ["const x = 1;"] });
});

test("Markdown tables become preformatted text and raw HTML remains literal", () => {
	const nodes = markdownToTelegraphNodes("| A | B |\n| - | - |\n| 1 | 2 |\n\n<b>literal</b>");
	assert.deepEqual(nodes, [
		{ tag: "pre", children: ["A | B\n1 | 2"] },
		{ tag: "p", children: ["<b>literal</b>"] },
	]);
});

test("raw Telegraph nodes are cloned and reject unsafe or malformed structures", () => {
	const input = [
		{
			tag: "p",
			children: [
				"hello",
				{ tag: "a", attrs: { href: "mailto:test@example.com" }, children: ["mail"] },
			],
		},
	];
	const normalized = validateTelegraphNodes(input);
	assert.deepEqual(normalized, input);
	assert.notEqual(normalized, input);

	assert.throws(() => validateTelegraphNodes([]), /non-empty array/i);
	assert.throws(() => validateTelegraphNodes([{ tag: "script" }]), /unsupported.*tag/i);
	assert.throws(
		() => validateTelegraphNodes([{ tag: "a", attrs: { onclick: "bad" } }]),
		/unsupported.*attribute/i,
	);
	assert.throws(
		() => validateTelegraphNodes([{ tag: "a", attrs: { href: "javascript:alert(1)" } }]),
		/unsafe href/i,
	);
	assert.throws(
		() => validateTelegraphNodes([{ tag: "img", attrs: { src: "data:image/png,x" } }]),
		/unsafe src/i,
	);
	assert.throws(() => validateTelegraphNodes([{ tag: "p", surprise: true }]), /unknown property/i);
});

test("raw Telegraph node validation rejects cycles, deep trees, and oversized content", () => {
	const cyclic: { tag: string; children: unknown[] } = { tag: "p", children: [] };
	cyclic.children.push(cyclic);
	assert.throws(() => validateTelegraphNodes([cyclic]), /cycle/i);

	let deep: unknown = "end";
	for (let index = 0; index < 70; index += 1) deep = { tag: "p", children: [deep] };
	assert.throws(() => validateTelegraphNodes([deep]), /nesting/i);

	assert.throws(
		() => validateTelegraphNodes([{ tag: "p", children: ["x".repeat(MAX_CONTENT_BYTES)] }]),
		/64 KB/i,
	);
});

test("node URLs are trimmed and Markdown destinations preserve parentheses", () => {
	const nodes = validateTelegraphNodes([
		{
			tag: "p",
			children: [
				{
					tag: "a",
					attrs: { href: " https://example.com/a)b " },
					children: ["link"],
				},
			],
		},
	]);

	assert.deepEqual(nodes, [
		{
			tag: "p",
			children: [
				{
					tag: "a",
					attrs: { href: "https://example.com/a)b" },
					children: ["link"],
				},
			],
		},
	]);
	assert.equal(telegraphNodesToMarkdown(nodes), "[link](<https://example.com/a)b>)\n");
});

test("node-to-Markdown code fences exceed every backtick run in the content", () => {
	const markdown = telegraphNodesToMarkdown([
		{ tag: "p", children: [{ tag: "code", children: ["a``b"] }] },
		{ tag: "p", children: [{ tag: "code", children: ["`quoted`"] }] },
		{ tag: "p", children: [{ tag: "code", children: [" spaced "] }] },
		{ tag: "pre", children: ["before ```` after"] },
	]);

	assert.equal(
		markdown,
		"```a``b```\n\n`` `quoted` ``\n\n`  spaced  `\n\n`````\nbefore ```` after\n`````\n",
	);
});

test("Telegraph nodes convert back to deterministic readable Markdown", () => {
	const markdown = telegraphNodesToMarkdown([
		{ tag: "h3", children: ["Heading"] },
		{
			tag: "p",
			children: [
				"See ",
				{ tag: "strong", children: ["this"] },
				" and ",
				{ tag: "a", attrs: { href: "https://example.com" }, children: ["link"] },
			],
		},
		{ tag: "ul", children: [{ tag: "li", children: ["one"] }] },
		{ tag: "video", attrs: { src: "https://example.com/a.mp4" } },
	]);

	assert.equal(
		markdown,
		"### Heading\n\nSee **this** and [link](https://example.com)\n\n- one\n\n[Video](https://example.com/a.mp4)\n",
	);
});
