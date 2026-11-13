# Changelog

## 0.2.0 (Unreleased)

- Reject malformed gateway request URLs with `400` instead of crashing the gateway or web server; catch any unexpected handler failure.
- Refuse to start the gateway on a non-loopback `--host`, or with a `*` CORS origin, unless a gateway key is set.
- Limit concurrent gateway generations (`429` when full) and validate `max_tokens` and `temperature` ranges.
- Map provider auth failures to `401` with typed errors and use status-based OpenAI/Anthropic error types.
- Apply Web UI logout state and request cancellation to the embedded gateway, including API-key mode.
- Emit SDK-compatible Responses lifecycle events, `response.failed` on errors, and incomplete status at output-token limits; always open Anthropic content blocks before deltas.
- Enforce `tool_choice` `auto`/`none` and reject unsupported tool restrictions instead of silently dropping them.
- **Breaking:** Removed DeepSeek Harness (`@deepseek-ai/dsh-*`, `@deepseek-ai/cordis`) middleware, Cordis plugin patches, and sandboxed subprocess runtime; `frontier-connector` now has zero runtime npm dependencies.
- Added standalone OpenAI/Anthropic-compatible HTTP API gateway (`frontier serve`, `startGatewayServer`) exposing `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/models`, and `/health` so any external app or SDK can connect directly to Claude and OpenAI subscriptions.
- Added unified `FrontierConnector` programmatic client (`src/connector.ts`) with model prefix routing (`claude/`, `openai/`), automatic provider inference, and direct `generate()` / `stream()` methods.
- Added direct inline base64 and `data:` URL image resolution without requiring an external attachment service.
- Support OpenAI attachment-backed images and multimodal inputs via optional attachment resolver.
- Capture and replay OpenAI encrypted reasoning items across tool calls to preserve model chain-of-thought.
- Resilient loopback OAuth callback validation accepting `127.0.0.1` and `localhost` interchangeably.
- Add full OpenAI provider support to CLI (`auth login`, `auth logout`, `auth status`, `models`, `usage`, `chat`).
- Support configurable workspace directory (`--cwd` in CLI and `/api/workspace` in web app).
- Add conversation export (Markdown and JSON) and JSON import to web app.
- Add comprehensive Product Requirements Document (`docs/PRD.md`).
- Run web conversations through the DeepSeek Harness SDK profile with Claude or OpenAI.
- Display live tool inputs, outputs, errors, retries, and subagent lifecycle events.
- Support OpenAI model discovery, function tools, and tolerant SSE content-type handling.
- Preserve independent provider logout and cancellation of active Harness processes.
- Separate runtime ownership, activity translation, and HTTP chat validation into focused modules.
- Add contributor templates, release guidance, and package-content validation.

This remains an experimental integration with provider subscription endpoints. The
package version stays at 0.1.0 until a tagged release is prepared.
