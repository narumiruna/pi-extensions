const IMAGE_DRAG_TYPE = "application/x-pi-webui-image";

export function createImageDragController(previews, { isLocked, onDrop }) {
	let draggedId = "";

	function clearDropTargets() {
		previews.classList.remove("vertical-drop");
		for (const candidate of previews.children) {
			candidate.classList.remove("drag-before", "drag-after");
		}
	}

	function setDropTarget(item, after, vertical) {
		previews.classList.toggle("vertical-drop", vertical);
		for (const candidate of previews.children) {
			candidate.classList.toggle("drag-before", candidate === item && !after);
			candidate.classList.toggle("drag-after", candidate === item && after);
		}
	}

	function focus(id) {
		requestAnimationFrame(() => {
			const escapedId = CSS.escape(id);
			const item = previews.querySelector(`[data-image-id="${escapedId}"]`);
			(item?.tabIndex === 0 ? item : item?.querySelector(".remove-image"))?.focus();
		});
	}

	function bind(item, { id, orderingLocked }) {
		item.addEventListener("dragstart", (event) => {
			if (isLocked() || orderingLocked || !event.dataTransfer) return;
			draggedId = id;
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData(IMAGE_DRAG_TYPE, id);
			item.classList.add("dragging");
		});
		item.addEventListener("dragend", () => {
			draggedId = "";
			item.classList.remove("dragging");
			clearDropTargets();
		});
		item.addEventListener("dragover", (event) => {
			const sourceId = draggedId || event.dataTransfer?.getData(IMAGE_DRAG_TYPE);
			if (isLocked() || orderingLocked || !sourceId) return;
			if (sourceId === id) {
				clearDropTargets();
				return;
			}
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
			const vertical = imagesStackVertically(previews.children);
			setDropTarget(item, dropAfterTarget(event, item, vertical), vertical);
		});
		item.addEventListener("dragleave", (event) => {
			if (event.relatedTarget && item.contains(event.relatedTarget)) return;
			item.classList.remove("drag-before", "drag-after");
		});
		item.addEventListener("drop", (event) => {
			const sourceId = draggedId || event.dataTransfer?.getData(IMAGE_DRAG_TYPE);
			if (isLocked() || orderingLocked || !sourceId || sourceId === id) return;
			event.preventDefault();
			event.stopPropagation();
			const vertical = imagesStackVertically(previews.children);
			const after = dropAfterTarget(event, item, vertical);
			draggedId = "";
			clearDropTargets();
			onDrop({ sourceId, targetId: id, after });
		});
	}

	return { bind, clearDropTargets, focus };
}

export function imagesStackVertically(items) {
	const list = [...items];
	return !list.some((item, index) =>
		list.slice(index + 1).some((candidate) => Math.abs(item.offsetTop - candidate.offsetTop) < 2),
	);
}

export function dropAfterTarget(event, item, vertical) {
	const bounds = item.getBoundingClientRect();
	return vertical
		? event.clientY >= bounds.top + bounds.height / 2
		: event.clientX >= bounds.left + bounds.width / 2;
}
