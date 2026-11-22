---
"@narumitw/pi-sync": minor
"@narumitw/pi-sync-daemon": patch
---

Replace the individual automation switches with one reviewed **Sync mode** setting. New setups start in **Manual**. **Automatic** uses the daemon's existing idle scheduler and the selected Pi model for supported conflicts, without the legacy shutdown push. Existing flag combinations stay intact and appear as **Custom** when they do not match either preset.

Review the current policy from the same row when connected approval is required. Saving a mode does not start a transfer, and automatic work stays blocked if required approval is missing. The daemon prevents a mode change or connected review from reviving stale after-exit permission; allowing work after the last Pi exits still requires separate approval.
