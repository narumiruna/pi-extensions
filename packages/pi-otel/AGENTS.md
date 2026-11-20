# Pi OTel Guidelines

- Redact embedded base64 data URIs anywhere in stringified trace content before observations end because Langfuse's media scanner can reject data-URI-like substrings.
- Keep `@opentelemetry/exporter-trace-otlp-http` as a direct runtime dependency because Pi extension installation can omit the peer expected by `@langfuse/otel`.
