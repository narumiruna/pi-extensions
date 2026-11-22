export type SyncMode = "Manual" | "Automatic";

type Automation = {
  automatic: boolean;
  automaticTransfer?: boolean;
  agentMode?: boolean;
  continuous?: boolean;
};

export function syncMode(flags: Automation): SyncMode | "Custom" {
  if (flags.automatic || flags.automaticTransfer) return "Custom";
  if (flags.agentMode && flags.continuous) return "Automatic";
  return flags.agentMode || flags.continuous ? "Custom" : "Manual";
}

export function syncModeFlags(mode: SyncMode): Required<Automation> {
  return {
    automatic: false,
    automaticTransfer: false,
    agentMode: mode === "Automatic",
    continuous: mode === "Automatic",
  };
}

export function customAutomationSummary(flags: Automation): string {
  return [
    flags.automatic && "startup check / eligible shutdown push",
    flags.automaticTransfer && "startup transfer",
    flags.agentMode && "autonomous sync",
    flags.continuous && (flags.agentMode ? "continuous sync" : "continuous sync (paused)"),
  ]
    .filter(Boolean)
    .join(", ");
}
