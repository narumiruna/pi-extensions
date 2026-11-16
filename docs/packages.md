# Package documentation

Use this index for detailed package guides and developer references.
For packages without a separate documentation directory, start with the [repository package catalog](../README.md#-choose-an-extension).
Each package README remains the entry point for installation, supported interfaces, compatibility, and safety warnings.

Verification records describe the revision and checks recorded there; they do not establish current release readiness.
Compatibility indexes remain available at their existing paths and point to the current owner.

## Coding and delegation

### pi-codex-compact

[Package README](../packages/pi-codex-compact/README.md)

- [Historical research: Codex compaction mechanism](../packages/pi-codex-compact/docs/codex-compaction-mechanism.md)
- [Codex Compact implementation reference](../packages/pi-codex-compact/docs/implementation.md)
- [Checkpoint replay after a Responses model switch](../packages/pi-codex-compact/docs/model-switch-validation.md) — developer evidence.
- [Checkpoint replay after a provider switch](../packages/pi-codex-compact/docs/provider-switch-validation.md) — developer evidence.
- [Codex Compact settings reference](../packages/pi-codex-compact/docs/settings.md)

### pi-codex-imagegen

[Package README](../packages/pi-codex-imagegen/README.md)

- [Architecture](../packages/pi-codex-imagegen/docs/architecture.md)
- [Codex image protocol contract](../packages/pi-codex-imagegen/docs/protocol.md)
- [Verification and release handoff](../packages/pi-codex-imagegen/docs/verification.md) — developer evidence.
- [Workflows](../packages/pi-codex-imagegen/docs/workflows.md)

### pi-context-management

[Package README](../packages/pi-context-management/README.md)

- [Experimental context management](../packages/pi-context-management/docs/context-management.md)

### pi-files

[Package README](../packages/pi-files/README.md)

- [Edit scope reference](../packages/pi-files/docs/edit-scope-reference.md)
- [File context reference](../packages/pi-files/docs/file-context-reference.md)
- [Migrate to Pi Files](../packages/pi-files/docs/migration.md)
- [Pi Files verification](../packages/pi-files/docs/verification.md) — developer evidence.

### pi-illustrate

[Package README](../packages/pi-illustrate/README.md)

- [Verification and external handoff](../packages/pi-illustrate/docs/verification.md) — developer evidence.

### pi-lsp

[Package README](../packages/pi-lsp/README.md)

- [Pi LSP settings reference](../packages/pi-lsp/docs/settings.md)

### pi-plan-mode

[Package README](../packages/pi-plan-mode/README.md)

- [Plan command workflows](../packages/pi-plan-mode/docs/command-workflows.md)
- [Pi Plan Mode settings reference](../packages/pi-plan-mode/docs/settings.md)

### pi-subagents

[Package README](../packages/pi-subagents/README.md)

- [Pi Subagents attachment behavior](../packages/pi-subagents/docs/attachments.md)
- [Conversation presentation](../packages/pi-subagents/docs/conversation-display.md)
- [Design principles](../packages/pi-subagents/docs/design-principles.md)
- [Per-child IPC transport idea](../packages/pi-subagents/docs/ipc-transport-idea.md) — unverified proposal.
- [Pi Subagents messaging and lifecycle](../packages/pi-subagents/docs/messaging.md)
- [Pi Subagents tools](../packages/pi-subagents/docs/tools.md)

## Browser

### pi-chrome-devtools

[Package README](../packages/pi-chrome-devtools/README.md)

- [Pi Chrome DevTools browser setup reference](../packages/pi-chrome-devtools/docs/browser-setup.md)

## Task workflows

### pi-btw

[Package README](../packages/pi-btw/README.md)

- [Pi core alignment and API handoff](../packages/pi-btw/docs/core-alignment.md)
- [Manual main-context import: runtime audit](../packages/pi-btw/docs/main-context-runtime.md)
- [Main-thread tree snapshots](../packages/pi-btw/docs/main-tree-snapshots.md)
- [Native conversation appearance](../packages/pi-btw/docs/native-appearance.md)
- [Side-thread workflows](../packages/pi-btw/docs/workflows.md)

### pi-goal

[Package README](../packages/pi-goal/README.md)

- [pi-goal interruption and continuation lifecycle](../packages/pi-goal/docs/continuation-lifecycle.md)
- [Managing goals](../packages/pi-goal/docs/managing-goals.md)
- [Pi Goal settings reference](../packages/pi-goal/docs/settings.md)

## Accounts and data

### pi-accounts

[Package README](../packages/pi-accounts/README.md)

- [Named Account Protocols v1](../packages/pi-accounts/docs/api/accounts-v1.md)
- [OAuth Credential Readiness Protocol v1](../packages/pi-accounts/docs/api/oauth-credential-readiness-v1.md)
- [OAuth Credential Source Protocol v1](../packages/pi-accounts/docs/api/oauth-credential-source-v1.md)

### pi-agentfs

[Package README](../packages/pi-agentfs/README.md)

- [Dependency security](../packages/pi-agentfs/docs/dependency-security.md)
- [Service integration](../packages/pi-agentfs/docs/integration.md)

### pi-sync

[Package README](../packages/pi-sync/README.md)

- [Autonomous and Continuous sync recovery boundaries](../packages/pi-sync/docs/agent-continuous-hardening.md) — developer evidence.
- [Autonomous sync implementation verification](../packages/pi-sync/docs/agent-mode-verification.md) — developer evidence.
- [Synthetic Autonomous sync merge-quality verification](../packages/pi-sync/docs/agent-quality-verification.md) — developer evidence.
- [Content merge and partial-progress audit](../packages/pi-sync/docs/content-merge-audit.md) — developer evidence.
- [Continuous sync verification](../packages/pi-sync/docs/continuous-sync-verification.md) — developer evidence.
- [Daemon migration and release restrictions](../packages/pi-sync/docs/daemon-migration.md)
- [Exclude policy safety audit](../packages/pi-sync/docs/exclude-policy-audit.md) — developer evidence.
- [File merge safety and recovery](../packages/pi-sync/docs/merge-implementation-audit.md) — developer evidence.
- [Settings merge audit](../packages/pi-sync/docs/settings-merge-audit.md) — developer evidence.
- [Pi Sync settings reference](../packages/pi-sync/docs/settings.md)
- [Sync TUI behavior contract](../packages/pi-sync/docs/tui-contract.md)

### pi-usage

[Package README](../packages/pi-usage/README.md)

- [Network-free usage identity checks](../packages/pi-usage/docs/api/auth-identity.md)
- [Read-only usage API v1](../packages/pi-usage/docs/api/usage-v1.md)
- [Usage queries and provider targets](../packages/pi-usage/docs/operations.md)
- [Provider guides](../packages/pi-usage/docs/providers/README.md)
- [Anthropic Claude extra usage](../packages/pi-usage/docs/providers/anthropic.md)
- [Baseten Model APIs spend](../packages/pi-usage/docs/providers/baseten.md)
- [Command Code](../packages/pi-usage/docs/providers/command-code.md)
- [DeepSeek API balance](../packages/pi-usage/docs/providers/deepseek.md)
- [Fireworks API spend](../packages/pi-usage/docs/providers/fireworks.md)
- [GitHub Copilot](../packages/pi-usage/docs/providers/github-copilot.md)
- [Kimi For Coding](../packages/pi-usage/docs/providers/kimi-coding.md)
- [MiniMax Token Plan and API balance](../packages/pi-usage/docs/providers/minimax.md)
- [Moonshot AI API balance](../packages/pi-usage/docs/providers/moonshotai.md)
- [OpenAI Codex](../packages/pi-usage/docs/providers/openai-codex.md)
- [OpenAI native ChatGPT OAuth](../packages/pi-usage/docs/providers/openai.md)
- [OpenCode Go (Zen)](../packages/pi-usage/docs/providers/opencode-go.md)
- [OpenRouter](../packages/pi-usage/docs/providers/openrouter.md)
- [Vercel AI Gateway credits](../packages/pi-usage/docs/providers/vercel-ai-gateway.md)
- [xAI consumer subscriptions](../packages/pi-usage/docs/providers/xai.md)
- [Z.AI (GLM Coding Plan)](../packages/pi-usage/docs/providers/zai.md)
- [Quota statusline display templates](../packages/pi-usage/docs/statusline-display.md)

## Status and observability

### pi-inspect

[Package README](../packages/pi-inspect/README.md)

- [Verification evidence](../packages/pi-inspect/docs/VERIFICATION.md) — developer evidence.
- [Cache history contract](../packages/pi-inspect/docs/cache-history.md)
- [Viewer reference](../packages/pi-inspect/docs/viewer.md)

### pi-langfuse

[Package README](../packages/pi-langfuse/README.md)

- [Durable tracing](../packages/pi-langfuse/docs/durable.md)

### pi-notify

[Package README](../packages/pi-notify/README.md)

- [Notify settings and behavior](../packages/pi-notify/docs/settings.md)

### pi-stamp

[Package README](../packages/pi-stamp/README.md)

- [Pi Stamp settings](../packages/pi-stamp/docs/settings.md)

### pi-starship

[Package README](../packages/pi-starship/README.md)

- [Configuration chat runtime](../packages/pi-starship/docs/configuration-chat-runtime.md)

### pi-statusline

[Package README](../packages/pi-statusline/README.md)

- [Pi Statusline configuration reference](../packages/pi-statusline/docs/configuration.md)
- [Extension status metadata v1](../packages/pi-statusline/docs/extension-status-protocol.md)

## Libraries

### pi-tui-kit

[Package README](../packages/pi-tui-kit/README.md)

- [Pi TUI Kit API reference](../packages/pi-tui-kit/docs/api.md)
- [Native TUI alignment audits](../packages/pi-tui-kit/docs/core-alignment-audit.md) — developer evidence.
- [Editor status presentation](../packages/pi-tui-kit/docs/editor-status-presentation.md)
- [Internal standalone error reporting](../packages/pi-tui-kit/docs/error-routing.md)
- [Fullscreen terminal handoff](../packages/pi-tui-kit/docs/fullscreen-handoff.md)
- [Responsive list UI/UX review](../packages/pi-tui-kit/docs/responsive-lists-uiux.md)
- [Showcase, search, and copy verification](../packages/pi-tui-kit/docs/showcase-verification.md) — developer evidence.
- [Consumer UI consolidation audit](../packages/pi-tui-kit/docs/ui-consolidation-audit.md) — developer evidence.

### sync-daemon

[Package README](../packages/sync-daemon/README.md)

- [Ownership and safety contract](../packages/sync-daemon/docs/architecture.md)
