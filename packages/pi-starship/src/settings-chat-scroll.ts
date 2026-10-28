import { ScrollView } from "@earendil-works/pi-tui";
import type { SettingsChatAnchor } from "./settings-chat-transcript.js";

/** Native layout owns clipping; this adapter retains message identity across history changes. */
export class SettingsChatScrollView extends ScrollView {
  anchor: SettingsChatAnchor | undefined;
  restoreAnchor?: (anchor: SettingsChatAnchor) => number;

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    const manual = !this.isFollowingEnd;
    const target = manual && this.anchor ? this.restoreAnchor?.(this.anchor) : undefined;
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    // Resizing or collapsing output can temporarily make the content fit. That must
    // not silently enable follow-end after the user chose an older message.
    if (manual) this.scrollTo(target ?? this.scrollTop, { disableFollow: true });
  }
}
