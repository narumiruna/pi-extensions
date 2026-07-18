import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ImageDropRuntime } from "./runtime.js";

export default function imageDrop(pi: ExtensionAPI) {
	const runtime = new ImageDropRuntime(pi);
	runtime.register();
}

export { ImageDropRuntime } from "./runtime.js";
