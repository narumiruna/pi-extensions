export class RetiredIgnorePolicyError extends Error {
  constructor(readonly kind: "settings" | "snapshot" | "recovery" | "baseline") {
    const reason = {
      settings: "Ignore-file sync settings are no longer supported.",
      snapshot: "This remote uses a retired ignore-file snapshot format.",
      baseline: "The last accepted sync is bound to a retired ignore-file policy.",
      recovery: "An ignore-file operation still needs recovery with a compatible Pi Sync build.",
    }[kind];
    super(`${reason} Preserve the data and use /skill:configure-pi-sync for guidance.`);
  }
}

export function retiredIgnorePolicy(kind: RetiredIgnorePolicyError["kind"]) {
  return new RetiredIgnorePolicyError(kind);
}
