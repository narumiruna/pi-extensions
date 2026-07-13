# 🪢 pi-langfuse — Langfuse Observability for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-langfuse)](https://www.npmjs.com/package/@narumitw/pi-langfuse) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-langfuse` is a [Pi coding agent](https://pi.dev) extension that sends Pi LLM generations, agent runs, and tool executions to [Langfuse](https://langfuse.com/) through OpenTelemetry.

## ✨ Features

- Creates a native Langfuse `agent` observation for each Pi agent run.
- Records serialized provider payloads after context filtering and finalized assistant outputs.
- Records provider, model, stop reason, token usage, and known non-zero reported cost.
- Records normalized tool inputs, finalized outputs, duration, and failures as child spans.
- Groups traces with Pi's session id.
- Records provider HTTP status codes when Pi exposes them.
- Reads Langfuse credentials and options only from a private `pi-langfuse.json` file.
- Batches routine exports without delaying normal Pi agent completion.
- Keeps its OpenTelemetry provider isolated so it coexists with other tracing extensions.
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

Create or update the private config interactively from Pi:

```text
/langfuse init
```

The command prompts for the secret key, public key, and base URL in the same order Langfuse presents them. Leave either key blank to preserve its existing value when updating a valid config. Leave the base URL blank to use `https://us.cloud.langfuse.com`. The file is saved atomically with mode `0600`; restart Pi after saving. In print or JSON mode, edit the file manually because interactive input is unavailable.

You can also create the file manually:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://us.cloud.langfuse.com",
  "environment": "development",
  "release": "local",
  "captureContent": true
}
```

`publicKey` and `secretKey` are required literal strings. Environment-variable and command interpolation are intentionally unsupported. `baseUrl` defaults to `https://us.cloud.langfuse.com`; regional and self-hosted HTTP or HTTPS endpoints are supported. Prefer HTTPS because HTTP sends Langfuse credentials and trace content without transport encryption.

`environment` and `release` are optional Langfuse trace attributes. Set `captureContent` to `false` to trace timing, model, usage, cost, and status metadata without sending prompts, responses, or tool content.

The extension automatically restricts an existing config file to mode `0600` and refuses to load credentials if that protection cannot be enforced. You can also set it explicitly:

```bash
chmod 600 ~/.pi/agent/pi-langfuse.json
```

Restart Pi after changing credentials, endpoint, environment, or release. The isolated OpenTelemetry tracer provider is initialized once per Pi process and selected only for Langfuse; it does not replace Pi's process-global provider or send Langfuse observations to another extension's exporter.

## 🔭 What is traced

Each `pi.agent` native `agent` observation contains:

- a `pi.llm` native `generation` for every provider request;
- a `pi.tool.<tool-name>` native `tool` observation for every tool execution;
- the Pi session id, working directory, mode, provider, and model;
- generation token usage and positive total cost when Pi reports a known price;
- error levels and status messages for failed provider responses, model calls, and tools.

Generation input uses Pi's serialized provider payload after context filters, and assistant output is reconciled after message transformers. Tool input is captured after argument preparation and `tool_call` mutations, while tool output is captured after `tool_result` transformers.

Images are represented without their base64 payload, including provider data URLs. Every captured input or output has one cumulative 64 KiB serialized UTF-8 budget, bounded object/array traversal, and deterministic truncation markers. Langfuse credentials are masked again in the span processor before network export.

Completed observations are exported in batches while Pi remains live. Normal `agent_end` handling never waits for Langfuse network I/O. Use `/langfuse flush` when you need to wait for completed exports; quit shutdown also drains the provider.

Automatic retries or continuations that begin without a new user prompt are recorded as a new trace labeled `[automatic continuation]`, so provider activity is not lost on Pi versions without a final `agent_settled` extension event.

## 💬 Command

```text
/langfuse status
/langfuse flush
/langfuse help
/langfuse config
/langfuse init
```

- `status` reports whether tracing is enabled, the endpoint, configuration source, and content-capture mode. It never displays credentials.
- `flush` waits for all completed observations to export.
- `help` displays command guidance.
- `config` displays the config path and a credential-free JSON template. It never opens an interactive prompt or echoes configured keys.
- `init` interactively creates or updates the private config without displaying existing credentials. Blank keys preserve valid existing values; a blank base URL uses the US cloud endpoint.

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
