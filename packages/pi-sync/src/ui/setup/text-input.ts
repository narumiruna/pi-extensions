import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalizeS3Bucket, requiredString } from "../../settings/settings-validation.js";
import { errorMessage } from "../../sync/sync-errors.js";
import { safeTerminalText } from "../terminal-text.js";

export type ValidateInput = (value: string) => string | Promise<string>;

export async function requiredExistingBucket(ctx: ExtensionCommandContext, example: string, signal?: AbortSignal) {
  return requiredValueInput(
    ctx,
    "Existing bucket\n\nThe bucket must already exist; pi-sync will not create it.",
    example,
    signal,
    normalizeS3Bucket,
  );
}

export async function requiredInput(
  ctx: ExtensionCommandContext,
  title: string,
  defaultValue: string,
  signal?: AbortSignal,
  validate?: ValidateInput,
) {
  return promptTextInput(ctx, title, { defaultValue, validate, rejectPlaceholders: true }, signal);
}

export async function requiredValueInput(
  ctx: ExtensionCommandContext,
  title: string,
  example: string,
  signal?: AbortSignal,
  validate?: ValidateInput,
) {
  return promptTextInput(ctx, title, { example, validate, rejectPlaceholders: true }, signal);
}

export async function promptTextInput(
  ctx: ExtensionCommandContext,
  title: string,
  options: {
    defaultValue?: string;
    example?: string;
    validate?: ValidateInput;
    rejectPlaceholders?: boolean;
  },
  signal?: AbortSignal,
) {
  // Pi ignores placeholders. Keep defaults/examples visible; only an explicit blank accepts a default.
  const hint =
    options.defaultValue !== undefined
      ? `Default: ${safeTerminalText(options.defaultValue)} (leave blank to keep)`
      : `Example: ${safeTerminalText(options.example ?? "")}\nEnter your own value; this example is not a default.`;
  while (true) {
    signal?.throwIfAborted();
    const value = await ctx.ui.input(`${title}\n\n${hint}`, undefined, { signal });
    signal?.throwIfAborted();
    if (value === undefined) return undefined;
    try {
      const normalized = value.trim() || options.defaultValue;
      if (!normalized) throw new Error(`${title.split("\n")[0]} is required.`);
      if (options.rejectPlaceholders && /[<>]/u.test(normalized)) {
        throw new Error("Replace example placeholders such as <account-id> with your own value.");
      }
      const checked = requiredString(normalized, title.split("\n")[0] ?? "value");
      const result = options.validate ? await options.validate(checked) : checked;
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      ctx.ui.notify(`${errorMessage(error)} Enter a corrected value, or cancel.`, "warning");
    }
  }
}
