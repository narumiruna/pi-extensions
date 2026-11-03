import { type EntryRenderOptions, keyText } from "@earendil-works/pi-coding-agent";

export function entryRenderOptions(expanded: boolean): EntryRenderOptions {
  return {
    expanded,
    keyText,
    keyHint: (keybinding, description) => `${keyText(keybinding)} ${description}`,
  };
}
