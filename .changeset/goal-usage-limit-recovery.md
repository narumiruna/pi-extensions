---
"@narumitw/pi-goal": minor
---

Add default-off `retryUsageLimits` recovery for recognized provider quota errors. When enabled, Goal retains its identity and workflow ownership in active waiting, then schedules recovery through the settled-idle dispatcher using an applicable public reset hint or a 15-minute fallback. No usage service is required.

Only work-free, directly quota-rejected scheduled recovery requests are exempt from automatic-work and no-progress counters. Provider-reported token usage always counts; successful work, partial work, original requests, and native retries retain existing accounting.

Recovery can make paid requests and wait indefinitely for billing, credit, or entitlement action. Disabling it cancels pending quota recovery; enabling it does not restart an already stopped Goal. Native retry and ordinary external-wait policies remain unchanged.
