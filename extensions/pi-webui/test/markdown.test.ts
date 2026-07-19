import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const markdown = (await import(
	pathToFileURL(path.join(process.cwd(), "extensions/pi-webui/src/web/markdown.js")).href
)) as {
	parseMarkdown(input: string): Array<Record<string, unknown>>;
	isSafeLink(url: string): boolean;
};

test("Markdown parser structures common response content", () => {
	const nodes = markdown.parseMarkdown(
		"## Result\n\n- first\n- **second** with `code`\n\n> note\n\n```ts\nconst ok = true;\n```",
	);
	assert.deepEqual(
		nodes.map((node) => node.type),
		["heading", "list", "blockquote", "codeBlock"],
	);
	assert.equal(nodes[0]?.level, 2);
	assert.equal(nodes[1]?.ordered, false);
	assert.equal(nodes[3]?.language, "ts");
	assert.equal(nodes[3]?.text, "const ok = true;");
});

test("Markdown parser keeps incomplete streaming delimiters as text", () => {
	const nodes = markdown.parseMarkdown("Working on **unfinished\n\n```ts\nconst partial =");
	assert.equal(nodes[0]?.type, "paragraph");
	assert.match(JSON.stringify(nodes), /\*\*unfinished/);
	assert.equal(nodes[1]?.type, "codeBlock");
	assert.equal(nodes[1]?.text, "const partial =");
});

test("only HTTP and HTTPS links are interactive", () => {
	assert.equal(markdown.isSafeLink("https://example.com/path"), true);
	assert.equal(markdown.isSafeLink("http://127.0.0.1:3000"), true);
	assert.equal(markdown.isSafeLink("javascript:alert(1)"), false);
	assert.equal(markdown.isSafeLink("data:text/html,test"), false);
	assert.equal(markdown.isSafeLink("/relative"), false);
	const nodes = markdown.parseMarkdown(
		"[safe](https://example.com) [unsafe](javascript:alert(1)) <img onerror=alert(1)>",
	);
	assert.match(JSON.stringify(nodes), /https:\/\/example\.com/);
	assert.doesNotMatch(JSON.stringify(nodes), /"type":"link"[^}]*javascript:/);
	assert.match(JSON.stringify(nodes), /<img onerror=alert\(1\)>/);
});
