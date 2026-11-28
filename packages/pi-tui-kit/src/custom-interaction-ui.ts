import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const interactionUi = Symbol();

export interface InternalInteractionUi {
  [interactionUi]?: NonNullable<Parameters<ExtensionCommandContext["ui"]["custom"]>[1]>;
}
