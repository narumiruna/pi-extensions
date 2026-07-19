import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.join(process.cwd(), "extensions/pi-webui/src/web");
const [html, app, styles, transcript, markdown, imageDrag] = await Promise.all([
	readFile(path.join(root, "index.html"), "utf8"),
	readFile(path.join(root, "app.js"), "utf8"),
	readFile(path.join(root, "styles.css"), "utf8"),
	readFile(path.join(root, "transcript.js"), "utf8"),
	readFile(path.join(root, "markdown.js"), "utf8"),
	readFile(path.join(root, "image-drag.js"), "utf8"),
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
	assert.match(html, /id="attachment-summary"[^>]*hidden/);
	assert.doesNotMatch(html, /id="attachment-summary"[^>]*aria-live/);
	assert.match(
		html,
		/id="attachment-announcement"[^>]*class="visually-hidden"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/,
	);
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
	assert.match(app, /model\.imageLimits/);
	assert.match(app, /limits\.maxImages/);
	assert.match(app, /limits\.maxImageBytes/);
	assert.match(app, /limits\.maxBatchBytes/);
	assert.match(app, /events\.addEventListener\("image-limits"/);
	assert.doesNotMatch(app, /images\.length \+ files\.length > 8/);
	assert.doesNotMatch(app, /file\.size > 10 \* 1024 \* 1024/);
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
	assert.match(app, /model\.imageLimits\?\.maxImages \?\? model\.images\.length/);
	assert.match(app, /\$\{model\.images\.length\}\/\$\{maximum\} images attached/);
	assert.match(app, /Sensitive metadata is removed before sending\./);
	assert.match(app, /attachmentAnnouncement/);
	assert.match(app, /showModal/);
	assert.match(app, /previewReturnFocus.*focus/s);
	assert.match(app, /drag-active/);
	assert.match(app, /moveImageBefore/);
	assert.match(app, /moveImageAfter/);
	assert.match(app, /moveImage/);
	assert.match(
		app,
		/item\.draggable =\s*model\.images\.length > 1 && image\.status === "ready" && !orderingLocked/,
	);
	assert.match(imageDrag, /addEventListener\("dragstart"/);
	assert.match(app, /addEventListener\("keydown"/);
	assert.match(app, /aria-keyshortcuts/);
	assert.match(app, /attachment-order-context/);
	assert.match(app, /Order \$\{index \+ 1\} of \$\{model\.images\.length\}/);
	assert.doesNotMatch(app, /Move image earlier|Move image later|data-order-action/);
	assert.match(app, /imageDrag\.focus/);
	assert.match(imageDrag, /function focus\(id\)/);
	assert.match(html, /id="clear-attachments"[^>]*hidden/);
	assert.match(html, /id="clear-attachments-dialog"/);
	assert.match(html, /id="confirm-clear-attachments"/);
	assert.match(app, /model\.images\.length < 2/);
	assert.match(app, /\/api\/attachments\/clear/);
	assert.match(app, /retryFiles\.delete/);
	assert.match(app, /clearDialog\.showModal/);
	assert.match(app, /returnValue !== "confirm"/);
});

test("drag ordering gives directional feedback and updates before the request settles", () => {
	assert.match(app, /createImageDragController/);
	assert.match(imageDrag, /dropAfterTarget/);
	assert.match(imageDrag, /setDropTarget/);
	assert.match(imageDrag, /clearDropTargets/);
	assert.match(imageDrag, /imagesStackVertically/);
	assert.match(app, /model = \{ \.\.\.model, images \}/);
	assert.match(app, /preview\.draggable = false/);
	assert.match(styles, /\.image-preview-item\.drag-before/);
	assert.match(styles, /\.image-preview-item\.drag-after/);
	assert.match(styles, /\.image-previews\.vertical-drop/);
	assert.doesNotMatch(styles, /\.image-preview-item\.drag-target/);
});

test("sent-image actions stay contextual, authenticated, and distinguish expiration", () => {
	assert.match(app, /events\.addEventListener\("sent-images"/);
	assert.match(app, /\/api\/sent-images\/reattach/);
	assert.match(app, /\/api\/sent-images\/\$\{encodeURIComponent\(retainedImageId\)\}/);
	assert.match(transcript, /Attach again/);
	assert.match(transcript, /Forget/);
	assert.match(transcript, /Expired/);
	assert.match(transcript, /retainedImageStatus/);
	assert.match(transcript, /aria-label.*Attach image again/);
	assert.match(styles, /\.message-image-action/);
	assert.doesNotMatch(html, /sent-image-gallery|retained-image-gallery/);
});

test("attachment copy keeps summary, item state, and announcements non-duplicative", () => {
	for (const label of ["Uploading", "Processing", "Ready", "Needs attention", "Retry", "Remove"]) {
		assert.match(app, new RegExp(label));
	}
	assert.equal((app.match(/Sensitive metadata is removed before sending\./g) ?? []).length, 1);
	assert.doesNotMatch(app, /images attached[^\n]*attachmentPhaseLabel/);
	assert.match(app, /image\.notes\.join\(" · "\)/);
	assert.doesNotMatch(app, /alert\(/);
});

test("composer actions and attachment cards preserve visual priority and reflow", () => {
	assert.match(styles, /\.image-previews\s*\{[\s\S]*flex-wrap:\s*wrap/);
	assert.doesNotMatch(styles, /\.image-previews\s*\{[^}]*grid-template-columns/);
	assert.match(styles, /\.image-preview-item\s*\{[^}]*width:\s*fit-content/);
	assert.match(styles, /\.image-preview-item\s*\{[^}]*max-width:\s*100%/);
	assert.match(styles, /\.image-preview-item\s*\{[^}]*flex:\s*0 1 auto/);
	assert.match(
		styles,
		/\.image-preview-item\s*\{[^}]*grid-template-columns:\s*68px fit-content\(14rem\) auto/,
	);
	assert.match(styles, /\.remove-image\s*\{[^}]*background:\s*transparent/);
	assert.match(
		styles,
		/\.remove-image:hover:not\(:disabled\)[^}]*background:\s*var\(--danger-soft\)/,
	);
	assert.match(styles, /textarea:focus-visible[\s\S]*border-color:\s*transparent/);
	assert.doesNotMatch(styles, /\.image-order-actions|\.move-image/);
});

test("attachment removal uses an accessible trash icon", () => {
	assert.match(app, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
	assert.match(app, /remove\.setAttribute\("aria-label", `Remove image/);
	assert.match(app, /remove\.title = `Remove/);
	assert.doesNotMatch(app, /remove\.textContent = "Remove"/);
	assert.match(styles, /\.remove-image svg/);
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
	assert.match(styles, /\.image-previews\s*\{[\s\S]*flex-wrap:\s*wrap/);
	assert.match(
		styles,
		/\.image-preview-item\s*\{[\s\S]*grid-template-columns:\s*68px fit-content\(14rem\) auto/,
	);
});
