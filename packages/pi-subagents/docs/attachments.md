# Pi Subagents attachment behavior

`subagent_spawn` accepts explicit local `skills` and `extensions` for one child job. Automatic resource discovery and inheritance from the parent session remain disabled. See [Tools](./tools.md) for argument shapes and [Security and privacy](../README.md#-security-and-privacy) before attaching executable code.

## Skills

Each `skills` path must be an existing local Markdown file or directory with at least one skill Pi can load. Skill names must be unique across explicit paths and skills contributed by attached extension packages. Repeated canonical skill paths are removed in first-use order.

Every non-ignored declared skill must load successfully, including skills contributed by an attached extension package: an invalid or unreadable sibling cannot be hidden by a valid one. Pi-ignored draft skills remain excluded. Non-Markdown file paths, directories without a loadable skill, and duplicate skill names fail before launch.

Skills use Pi's progressive disclosure. Attaching one does not inject its complete body, add work tools, or force the child to invoke it.

Skill preflight is asynchronous and cancellation-aware. It rejects recursive directory links and combined explicit and package-skill scans exceeding 4,096 entries, depth 32, 4 MiB of candidate skill content, or 1 MiB of ignore-file content before Pi's synchronous loader runs.

## Extensions

Each `extensions` entry specifies an existing local extension file or directory and the exact extension tools to select initially. An empty `tools` list permits provider or lifecycle behavior without initially exposing extension tools. Tool names cannot overlap Pi core or the built-in `subagent_send` and `subagent_wait` tools; different attachments cannot request the same extension tool name.

An extension directory must resolve to at least one loadable Pi entrypoint. Every exact `pi.extensions` declaration must contribute a directly loadable entrypoint. Partially resolved packages and authoritative Pi manifests without extensions are rejected before launch.

Extension-package preflight is asynchronous and cancellation-aware. It rejects source globs in Pi resource declarations, recursive resource-directory links, and non-regular manifests or ignore files; its shared discovery budget is 4,096 entries, depth 32, and 1 MiB of metadata.

Every child uses a readiness probe to confirm its exact registered chat-model pair and current provider availability before receiving the task. When an extension is attached, the probe also reports source fingerprints for the requested active tools through a private descriptor after extension factory, session, and resource-discovery hooks. The parent matches each requested tool to the specified attachment's resolved entrypoints and observes startup-hook errors through an ordered RPC barrier before sending the task to the model. A missing or misattributed tool, invalid readiness response, startup failure, or cancellation fails the job before a model request. For untrusted projects, the parent also checks Pi's loaded skill and prompt command paths after resource discovery and before sending the task; project-local paths and symlinks into the project fail the job. Headless RPC does not expose themes to the child model.

An attached extension executes trusted code with the child process's user permissions and can alter prompts, providers, tools, or the active tool list after that initial check. The selected tool list is not a sandbox.

## Paths, limits, and providers

Attachment paths may be absolute or relative to the child working directory. They must already refer to regular files or directories and are canonicalized before launch. npm, Git, URL, and other nonlocal sources are not accepted. Repeated extension paths merge their selected tools in first-use order.

A job accepts at most 16 skill paths, 16 extension entries, and 64 selected core and extension tool names. Each path is limited to 4 KiB of UTF-8 text; each extension tool name is limited to 128 characters without commas or control characters. The serialized child bootstrap, including selected and communication tool names plus the requested provider, model, and thinking level, must fit 16 KiB of UTF-8 JSON. On Windows, the child command line must fit the 32,767 UTF-16 code-unit process limit.

When the project is untrusted, both lexical and symlink-resolved paths inside the child working directory are rejected for attachments and resources resolved from their extension packages. Explicit external paths remain available. Only attach code you trust: attachments are not permission boundaries.

The child inherits each omitted `provider` or `model` independently from the main agent at spawn time. Explicit values select exact IDs without fallback; see [Model selection](./tools.md#model-selection). Unlisted custom IDs, including inherited ones, require explicit model registration. Unavailable core tools, invalid attachments, or an unavailable session broker also fail before launch.

Without an attached extension, a provider registered only in the parent by an extension is unavailable to the child and spawn rejects it. This is a provider portability check, not a model-list lookup. Only the child checks exact model registration and availability. An attached extension can register a pair absent from the parent's catalog. A missing or unavailable pair fails the admitted job before the task is sent. Registered virtual models follow the same rule.

The requested pair is sent through the private bootstrap, not Pi's CLI model-pattern parser. Any initial default model is provisional and receives no task. The child binds the exact requested registration through Pi's public API before readiness. Attached code must finish registering the pair before that check; factory, `session_start`, or earlier `resources_discover` hooks can register it.

Exact child selection can run `model_select` hooks. Pi does not await asynchronous `thinking_level_select` handlers, so attached code can still change behavior after the initial check. Process-local runtime API keys, including a parent-only `--api-key`, cannot be forwarded. Attached providers must use stored credentials or inherited environment credentials the child can read independently.

Canonical attachment paths are passed to Pi as child-process arguments. Parent-generated inspection, completion, and broker metadata omit them; child diagnostic errors redact requested attachment roots before publication. Attached code and model output can still disclose accessible paths.
