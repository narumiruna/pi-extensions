import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WebUIRuntime } from "./runtime.js";

export default function webUI(pi: ExtensionAPI): void {
	const runtime = new WebUIRuntime(pi);
	runtime.register();
}

export { WebUIRuntime } from "./runtime.js";
