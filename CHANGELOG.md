# Changelog

## Unreleased

- Support OpenAI attachment-backed images and multimodal inputs via attachment resolver.
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
