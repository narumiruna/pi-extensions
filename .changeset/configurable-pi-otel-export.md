---
"@narumitw/pi-otel": minor
---

Rename the tracing extension to `pi-otel` and add OTLP/HTTP protobuf export to custom collectors. Generic export keeps prompts, model replies, and tool content local by default. Existing Langfuse settings and trace attributes remain supported.

Use `/otel` for all tracing controls, including Langfuse setup. `/langfuse` is deprecated and warns users to switch to `/otel` while still opening the same menu. Uninstall the old `pi-langfuse` package before loading `pi-otel` to avoid duplicate tracing.
