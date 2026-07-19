import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.join(process.cwd(), "extensions/pi-webui/src/web");
const [html, app, styles] = await Promise.all([
	readFile(path.join(root, "index.html"), "utf8"),
	readFile(path.join(root, "app.js"), "utf8"),
	readFile(path.join(root, "styles.css"), "utf8"),
]);

test("page hierarchy keeps session context, transcript, and composer in reading order", () => {
	assert.match(
		html,
		/<header[^>]*>[\s\S]*id="project-name"[\s\S]*id="connection-status"[\s\S]*<\/header>/,
	);
	assert.match(html, /<main[^>]*>[\s\S]*id="transcript"[\s\S]*id="composer"[\s\S]*<\/main>/);
	assert.match(html, /id="transcript"[^>]*aria-live="polite"/);
	assert.match(html, /id="message-input"[^>]*aria-label="Message Pi"/);
	assert.match(html, /id="send-next"[^>]*>Send now<\/button>/);
	assert.match(html, /id="steer"[^>]*hidden[^>]*>Steer now<\/button>/);
	assert.match(html, /id="composer-status"[^>]*role="status"/);
	assert.match(html, /id="blocking-state"[^>]*role="alert"[^>]*hidden/);
});

test("browser logic authenticates a lease, reconnects from sequence, and keeps failed drafts", () => {
	assert.match(app, /crypto\.randomUUID\(\)/);
	assert.match(app, /\/api\/lease/);
	assert.match(app, /new EventSource\(`\/api\/events\?since=\$\{model\.sequence\}`\)/);
	assert.match(app, /\/api\/messages/);
	assert.match(app, /prepareSend\(model, crypto\.randomUUID\(\), steer \? "steer" : "next"\)/);
	assert.match(app, /delivery: attempt\.delivery/);
	assert.match(app, /deliveryNotice\(model\)/);
	assert.match(app, /applyConversationEvent/);
	assert.match(app, /applySnapshot/);
	assert.match(app, /prepareSend/);
	assert.match(app, /completeSend/);
	assert.match(app, /failSend/);
	assert.match(app, /if \(!model\.leaseClaimed\) await claimLease\(\)/);
	assert.match(app, /snapshotRefresh/);
	assert.match(app, /if \(!response\.ok\) throw new Error/);
	assert.doesNotMatch(app, /localStorage|sessionStorage|indexedDB/i);
});

test("image input supports picker and paste with visible removable previews", () => {
	assert.match(
		html,
		/id="image-input"[^>]*type="file"[^>]*accept="image\/png,image\/jpeg,image\/webp,image\/gif"[^>]*multiple/,
	);
	assert.match(html, /id="image-previews"[^>]*aria-label="Attached images"/);
	assert.match(app, /addEventListener\("paste"/);
	assert.match(app, /URL\.createObjectURL/);
	assert.match(app, /URL\.revokeObjectURL/);
	assert.match(app, /Remove image/);
});

test("tool and thinking details use native disclosure and text-only DOM insertion", () => {
	assert.match(app, /document\.createElement\("details"\)/);
	assert.match(app, /summary\.textContent = "Thinking"/);
	assert.match(app, /renderTool/);
	assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|document\.write/);
});

test("responsive and accessibility CSS covers focus, targets, reflow, dark mode, and motion", () => {
	assert.match(styles, /:focus-visible/);
	assert.match(styles, /min-height:\s*44px/);
	assert.match(styles, /@media \(max-width: 640px\)/);
	assert.match(styles, /@media \(prefers-color-scheme: dark\)/);
	assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(styles, /overflow-wrap:\s*anywhere/);
	assert.match(styles, /max-width:\s*100%/);
});
