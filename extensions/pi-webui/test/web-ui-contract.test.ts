import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.join(process.cwd(), "extensions/pi-webui/src/web");
const [html, app, styles, transcript, markdown] = await Promise.all([
	readFile(path.join(root, "index.html"), "utf8"),
	readFile(path.join(root, "app.js"), "utf8"),
	readFile(path.join(root, "styles.css"), "utf8"),
	readFile(path.join(root, "transcript.js"), "utf8"),
	readFile(path.join(root, "markdown.js"), "utf8"),
]);

test("page hierarchy keeps session context, transcript, and composer in reading order", () => {
	assert.match(
		html,
		/<header[^>]*>[\s\S]*id="project-name"[\s\S]*id="connection-status"[\s\S]*<\/header>/,
	);
	assert.match(html, /<main[^>]*>[\s\S]*id="transcript"[\s\S]*id="composer"[\s\S]*<\/main>/);
	assert.match(html, /id="transcript"[^>]*>/);
	assert.doesNotMatch(html, /id="transcript"[^>]*aria-live/);
	assert.match(html, /id="transcript-status"[^>]*aria-live="polite"/);
	assert.match(html, /id="jump-latest"[^>]*hidden/);
	assert.match(html, /id="message-input"[^>]*aria-label="Message Pi"/);
	assert.match(html, /id="send-next"[^>]*>Send<\/button>/);
	assert.match(html, /id="steer"[^>]*hidden[^>]*>Steer<\/button>/);
	assert.match(html, /id="composer-status"[^>]*role="status"/);
	assert.match(html, /id="blocking-state"[^>]*role="alert"[^>]*hidden/);
});

test("browser logic authenticates a lease, reconnects from sequence, and keeps failed drafts", () => {
	assert.match(app, /crypto\.randomUUID\(\)/);
	assert.match(app, /\/api\/lease/);
	assert.match(app, /new EventSource\(`\/api\/events\?since=\$\{model\.sequence\}`\)/);
	assert.match(app, /\/api\/messages/);
	assert.match(app, /\/api\/draft/);
	assert.match(app, /scheduleDraftSave\(\)/);
	assert.match(app, /flushDraftText\(\)/);
	assert.match(app, /acknowledgeDraftText/);
	assert.match(app, /draftRevision: attempt\.draftRevision/);
	assert.match(app, /prepareSend\(model, crypto\.randomUUID\(\), steer \? "steer" : "next"\)/);
	assert.match(app, /delivery: attempt\.delivery/);
	assert.match(app, /deliveryNotice\(model\)/);
	assert.match(app, /applyConversationEvent/);
	assert.match(app, /applySnapshot/);
	assert.match(app, /prepareSend/);
	assert.match(app, /completeSend/);
	assert.match(app, /failSend/);
	assert.match(app, /if \(!model\.leaseClaimed\) await claimLease\(\)/);
	assert.match(app, /events\.addEventListener\("draft"/);
	assert.match(app, /applyLease\(model, snapshot\.lease, clientId\)/);
	assert.match(app, /applyLease\(model, await response\.json\(\), clientId, true\)/);
	assert.match(app, /snapshotRefresh/);
	assert.match(app, /createTranscriptRenderer/);
	assert.match(app, /noteUnseenUpdate/);
	assert.match(app, /followLatest/);
	assert.doesNotMatch(app, /ui\.transcript\.replaceChildren/);
	assert.match(app, /requestAnimationFrame/);
	assert.match(app, /if \(!response\.ok\) throw new Error/);
	assert.doesNotMatch(app, /localStorage|sessionStorage|indexedDB/i);
});

test("image input stages authenticated per-item uploads with visible status and recovery", () => {
	assert.match(
		html,
		/id="image-input"[^>]*type="file"[^>]*accept="image\/png,image\/jpeg,image\/webp,image\/gif,image\/bmp,image\/tiff,image\/heic,image\/heif,image\/avif,\.bmp,\.tif,\.tiff,\.heic,\.heif,\.avif"[^>]*multiple/,
	);
	assert.match(app, /image\/avif/);
	assert.match(app, /bmp\|tif\|tiff\|heic\|heif\|avif/);
	assert.match(app, /filter\(isSupportedImageFile\)/);
	assert.match(html, /id="image-previews"[^>]*aria-label="Attached images"/);
	assert.match(app, /addEventListener\("paste"/);
	assert.match(app, /\/api\/attachments\/reserve/);
	assert.match(app, /new XMLHttpRequest\(\)/);
	assert.match(app, /request\.upload\.addEventListener\("progress"/);
	assert.match(app, /X-Pi-Web-Client/);
	assert.match(app, /\/api\/attachments\/\$\{encodeURIComponent\(id\)\}\/upload/);
	assert.match(app, /\/api\/attachments\/\$\{encodeURIComponent\(id\)\}\/retry/);
	assert.match(app, /attachment-item-status/);
	assert.match(app, /attachment-conversion-summary/);
	assert.match(app, /Retry image/);
	assert.match(app, /Remove image/);
	assert.doesNotMatch(app, /URL\.createObjectURL|URL\.revokeObjectURL/);
	assert.match(html, /Paste, drop, or choose/);
	assert.match(html, /id="image-preview-dialog"/);
	assert.match(html, /id="attachment-status"[^>]*aria-live="polite"/);
	assert.match(app, /showModal/);
	assert.match(app, /previewReturnFocus.*focus/s);
	assert.match(app, /drag-active/);
	assert.match(app, /moveImageBefore/);
	assert.match(app, /moveImage/);
	assert.match(app, /item\.draggable = image\.status === "ready"/);
	assert.match(app, /addEventListener\("dragstart"/);
	assert.match(app, /Move image backward/);
	assert.match(app, /Move image forward/);
	assert.match(app, /focusOrderingControl/);
	assert.match(html, /id="clear-attachments"[^>]*hidden/);
	assert.match(html, /id="clear-attachments-dialog"/);
	assert.match(html, /id="confirm-clear-attachments"/);
	assert.match(app, /model\.images\.length < 2/);
	assert.match(app, /\/api\/attachments\/clear/);
	assert.match(app, /retryFiles\.delete/);
	assert.match(app, /clearDialog\.showModal/);
	assert.match(app, /returnValue !== "confirm"/);
});

test("attachment copy keeps routine status local and states metadata removal once", () => {
	for (const label of ["Uploading", "Processing", "Ready", "Needs attention", "Retry", "Remove"]) {
		assert.match(app, new RegExp(label));
	}
	assert.equal((app.match(/Sensitive metadata is removed before sending\./g) ?? []).length, 1);
	assert.match(app, /image\.notes\.join\(" · "\)/);
	assert.doesNotMatch(app, /alert\(/);
});

test("tool, thinking, and Markdown rendering use safe DOM construction", () => {
	assert.match(transcript, /createElement\("details"\)/);
	assert.match(transcript, /summary\.textContent = "Thinking"/);
	assert.match(transcript, /tool-result-disclosure/);
	assert.match(app, /createTranscriptRenderer/);
	assert.match(markdown, /createTextNode|textContent/);
	assert.doesNotMatch(
		`${app}\n${transcript}\n${markdown}`,
		/innerHTML|insertAdjacentHTML|document\.write/,
	);
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
