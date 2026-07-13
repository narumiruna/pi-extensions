# 🪢 pi-langfuse — Langfuse Observability for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-langfuse)](https://www.npmjs.com/package/@narumitw/pi-langfuse) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-langfuse` is a [Pi coding agent](https://pi.dev) extension that sends Pi LLM generations, agent runs, and tool executions to [Langfuse](https://langfuse.com/) through OpenTelemetry.

## ✨ Features

- Creates a Langfuse trace for each Pi agent run.
- Records LLM input, output, provider, model, stop reason, token usage, and reported cost.
- Records tool inputs, outputs, duration, and failures as child spans.
- Groups traces with Pi's session id.
- Records provider HTTP status codes when Pi exposes them.
- Reads Langfuse credentials and options only from a private `pi-langfuse.json` file.
- Flushes completed traces after each agent run and during session shutdown.
- Redacts Langfuse public and secret keys from exported trace data.
- Supports metadata-only tracing when content capture is disabled.

## 📦 Install

```bash
pi install npm:@narumitw/pi-langfuse
```

Try the local workspace package:

```bash
pi -e ./extensions/pi-langfuse
```

The Langfuse v4 SDK requires Node.js 20 or newer.

## ⚙️ Configuration

Create `~/.pi/agent/pi-langfuse.json`:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://cloud.langfuse.com",
  "environment": "development",
  "release": "local",
  "captureContent": true
}
```

`publicKey` and `secretKey` are required literal strings. Environment-variable and command interpolation are intentionally unsupported. `baseUrl` defaults to `https://cloud.langfuse.com`; regional and self-hosted HTTP or HTTPS endpoints are supported. Prefer HTTPS because HTTP sends Langfuse credentials and trace content without transport encryption.

`environment` and `release` are optional Langfuse trace attributes. Set `captureContent` to `false` to trace timing, model, usage, cost, and status metadata without sending prompts, responses, or tool content.

The extension automatically restricts an existing config file to mode `0600`. You can also set it explicitly:

```bash
chmod 600 ~/.pi/agent/pi-langfuse.json
```

Restart Pi after changing credentials, endpoint, environment, or release. The OpenTelemetry SDK is initialized once per Pi process so `/reload` and session replacement do not register duplicate global tracer providers.

## 🔭 What is traced

Each `pi.agent` trace contains:

- a `pi.llm` generation for every provider request;
- a `pi.tool.<tool-name>` child span for every tool execution;
- the Pi session id, working directory, mode, provider, and model;
- generation token usage and total cost when the provider reports them;
- error levels and status messages for failed provider responses, model calls, and tools.

Images are represented without their base64 payload. Long strings, deeply nested values, and oversized arrays are bounded before export. Langfuse credentials are masked again in the span processor before network export.

Automatic retries or continuations that begin without a new user prompt are recorded as a new trace labeled `[automatic continuation]`, so provider activity is not lost on Pi versions without a final `agent_settled` extension event.

## 💬 Command

```text
/langfuse status
/langfuse flush
```

- `status` reports whether tracing is enabled, the endpoint, configuration source, and content-capture mode. It never displays credentials.
- `flush` immediately exports all completed spans.

## 🔐 Privacy

With content capture enabled, traces can contain user prompts, system prompts, conversation context, model responses, tool arguments, and tool results. These may include source code, file contents, shell output, or other sensitive project data. Review your Langfuse retention and access controls before enabling this extension.

The built-in mask specifically protects Langfuse credentials; it is not a general secret scanner. Set `"captureContent": false` in `pi-langfuse.json` when content must remain local.

## 🗂️ Package layout

```txt
extensions/pi-langfuse/
├── src/
│   ├── langfuse.ts  # Pi lifecycle integration and slash command
│   ├── tracing.ts   # Trace lifecycle and content bounding
│   ├── runtime.ts   # Langfuse/OpenTelemetry runtime
│   └── config.ts    # Private pi-langfuse.json loading and validation
├── test/
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `langfuse.ts` is a Pi entrypoint; the other source modules are internal.

## 🔎 Keywords

Pi extension, Pi coding agent, Langfuse, LLM observability, OpenTelemetry, tracing, generations, tool spans, token usage, AI agent monitoring.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
