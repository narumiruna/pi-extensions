/** Keep the setting's automatic transfer scope visible in every setup summary. */
export function automaticSyncSummary(enabled: boolean) {
  return enabled ? "On (startup check; shutdown pushes selected content if sessions included)" : "Off";
}
