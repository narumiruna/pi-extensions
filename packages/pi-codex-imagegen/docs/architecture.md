# Architecture

`pi-codex-imagegen` generates images directly from Pi without starting Codex CLI, another agent, or Codex plugins. These diagrams describe the current implementation.

> **Endpoint:** The request contract is confirmed against [OpenAI Codex source](./protocol.md#source-mapping). The extension uses an internal ChatGPT endpoint, not the public OpenAI Images API. Real account access and transparent output have not been verified. See the [verification guide](./verification.md) for the remaining live checks and publication restrictions.

## Component boundaries

The manual menu and the optional model tool share one generation pipeline. Pi supplies OAuth authentication; the extension sends the request, validates the returned image, and saves its original bytes.

```mermaid
flowchart LR
    User["User"] --> Menu["/codex-imagegen<br/>Manual menu"]
    Agent["Pi agent"] --> Tool["codex_imagegen tool<br/>Enabled by default"]
    Menu --> Extension["pi-codex-imagegen"]
    Tool --> Extension
    Auth["Pi ModelRegistry<br/>openai-codex OAuth"] -->|Authentication| Extension
    Extension -->|HTTPS POST| Endpoint["ChatGPT internal endpoint<br/>gpt-image-2"]
    Endpoint -->|Base64 image| Extension
    Extension --> Validation["Validate image"]
    Validation --> File["Save original bytes<br/>to the explicit path"]
    File --> Result["Return path and image content"]
```

The main Pi model can use another provider. Image generation requires compatible Pi `openai-codex` OAuth; a login held only by Codex CLI is not used.

## Data and cancellation boundaries

Only the entered prompt and fixed generation options are sent as the request body. Pi supplies the token and account header. Conversation history, input files, and the destination path are not sent to the image endpoint.

```mermaid
flowchart LR
    subgraph Local["Local: Pi and extension"]
        Auth["Pi-managed OAuth"]
        Input["Entered prompt<br/>and fixed generation options"]
        Private["Not sent to endpoint:<br/>Conversation history, input files,<br/>and destination path"]
        Validate["Validate returned image"]
        Write["Write image<br/>Overwrite files and follow symlinks"]
    end
    subgraph Remote["Remote: ChatGPT"]
        Endpoint["Fixed HTTPS endpoint<br/>Redirects rejected"]
        Generation["Generate image<br/>May consume account quota"]
        Endpoint --> Generation
    end
    Auth -->|Authentication headers| Endpoint
    Input -->|JSON body| Endpoint
    Generation -->|Image data| Validate
    Validate --> Write
    Cancel["Cancellation, session replacement,<br/>reload, shutdown, or SDK disposal"] --> Stop["Abort owned HTTP work<br/>Reject stale continuations"]
    Stop -.-> Limits["Remote generation may continue<br/>Quota refund is not guaranteed<br/>Existing writes are not rolled back"]
```

Paths follow Pi's `write` behavior and are not confined to the repository. Symlinks can direct writes outside the project. Cancellation is best effort for filesystem writes, and an image saved before late cancellation remains on disk. Pi-owned OAuth refresh can also finish after the extension stops waiting.

## Implementation references

The diagrams map to these package modules:

- [`codex-imagegen.ts`](../src/codex-imagegen.ts): entry routes, shared generation pipeline, result publication, and session ownership.
- [`image-client.ts`](../src/image-client.ts): authentication checks, fixed endpoint, request limits, and HTTP cancellation.
- [`artifacts.ts`](../src/artifacts.ts): image validation, destination preflight, and binary file writes.
- [`menu.ts`](../src/menu.ts): manual generation and menu navigation.

See the [protocol contract](./protocol.md) for detailed authentication, failure, and storage behavior, and the [README](../README.md) for installation and use.

See [Workflows](./workflows.md) for manual generation, model-driven generation, and request ordering.
