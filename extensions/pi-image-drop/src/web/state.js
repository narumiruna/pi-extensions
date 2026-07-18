export function summarizeBatch(batch) {
	const counts = { ready: 0, uploading: 0, error: 0 };
	for (const item of batch.items ?? []) {
		if (item.status === "ready") counts.ready += 1;
		else if (item.status === "error") counts.error += 1;
		else counts.uploading += 1;
	}
	return {
		...counts,
		total: (batch.items ?? []).length,
		bytes: Number(batch.totalSourceBytes ?? 0),
		label: statusLabel(batch.phase, counts, (batch.items ?? []).length),
	};
}

export function statusLabel(phase, counts, total) {
	if (phase === "empty" || total === 0) return "No images staged";
	if (phase === "reserved") return `${total} ${plural(total, "image")} queued with Pi`;
	const parts = [`${counts.ready}/${total} ready`];
	if (counts.uploading > 0) parts.push(`${counts.uploading} uploading`);
	if (counts.error > 0) parts.push(`${counts.error} need attention`);
	return parts.join(" · ");
}

export function moveItem(ids, id, direction) {
	const from = ids.indexOf(id);
	if (from === -1) return [...ids];
	const to = Math.max(0, Math.min(ids.length - 1, from + direction));
	if (to === from) return [...ids];
	const next = [...ids];
	next.splice(from, 1);
	next.splice(to, 0, id);
	return next;
}

export function moveItemBefore(ids, id, targetId) {
	if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return [...ids];
	const next = ids.filter((candidate) => candidate !== id);
	next.splice(next.indexOf(targetId), 0, id);
	return next;
}

export function canMutate(batch) {
	return batch.phase !== "reserved" && batch.phase !== "closed";
}

export function preferNewestState(current, next) {
	if (!current || next.batch.revision >= current.batch.revision) return next;
	return current;
}

export function formatBytes(value) {
	const bytes = Math.max(0, Number(value) || 0);
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function plural(count, noun) {
	return count === 1 ? noun : `${noun}s`;
}
