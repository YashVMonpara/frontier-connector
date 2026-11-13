# Implementation map

`src/index.ts` exposes the standalone library and server APIs with zero runtime npm dependencies. `src/connector.ts` unifies `ClaudeAdapter` and `OpenAIAdapter` behind model/provider routing (`FrontierConnector`). `src/gateway.ts` and `src/http/gateway-translate.ts` expose standard OpenAI Chat Completions (`/v1/chat/completions`), OpenAI Responses (`/v1/responses`), Anthropic Messages (`/v1/messages`), and `/v1/models` endpoints so any external app or SDK can connect directly. `src/web-server.ts` serves the browser management/chat interface and mounts the gateway routes on the same loopback server. `src/cli.ts` exposes `auth`, `models`, `usage`, `chat`, `serve`, and `web` commands.

```text
External App / SDK ──► Gateway (/v1/chat/completions, /v1/messages, /v1/responses, /v1/models)
Browser UI         ──► Web Server (/api/auth/*, /api/chat, /api/usage)
Node.js App        ──► FrontierConnector (stream / generate / listModels)
                             │
             ┌───────────────┴───────────────┐
             ▼                               ▼
       ClaudeAdapter                   OpenAIAdapter
   TokenManager + TokenStore      OpenAITokens + openaiStore
   Anthropic Messages SSE         ChatGPT Responses SSE
```

## Modules

| Module | Responsibility |
| --- | --- |
| `types.ts` | Self-contained messages, content blocks, stream chunks, tool schemas, and `LlmError` |
| `auth/oauth.ts` | PKCE S256, loopback callback listener, state validation, token exchange and refresh |
| `auth/store.ts` | Versioned private JSON store (`0600`), atomic replacement, cross-process lockfiles |
| `auth/source.ts` | Explicit Claude Code Keychain/file import and file refresh synchronization |
| `auth/manager.ts` | Coordinated Claude token reads, preemptive refresh, rejected-token recovery |
| `auth/openai.ts` | ChatGPT OAuth grant, JWT account ID extraction, locked OpenAI token refresh |
| `claude.ts` | Claude subscription & API-key transport, catalog discovery, usage, streaming |
| `openai.ts` | OpenAI ChatGPT subscription transport, model discovery, encrypted reasoning replay, streaming |
| `connector.ts` | Unified `FrontierConnector` router, model prefixing (`claude/`, `openai/`), `generate()` helper |
| `gateway.ts` | Standalone HTTP gateway server, Host/Origin/API-key security, SSE/JSON protocol handlers |
| `http/gateway-translate.ts` | OpenAI Chat, OpenAI Responses, and Anthropic Messages request/response translators |
| `http/chat.ts` | Web UI chat payload validation |
| `web-server.ts` | Loopback Web UI server + embedded gateway routes |
| `transport.ts` | HTTP error classification, reset parsing, cancellable waits, stream idle watchdog |
| `translate/anthropic.ts` | Anthropic wire messages, cache markers, and SSE event translator |
| `translate/responses.ts` | OpenAI Responses input, tool schemas, encrypted reasoning capture, and SSE translator |
| `translate/sse.ts` | Incremental SSE byte-stream framing and upstream cancellation |
| `translate/resolved.ts` | Inline base64 / `data:` URL image passthrough and optional `AttachmentStore` resolution |

## Provenance

`translate/anthropic.ts`, `translate/sse.ts`, `translate/resolved.ts`, and `translate/responses.ts` were originally adapted from MIT-licensed files in `V1ki/dsh-plugin-subscriptions` and refactored for standalone operation without any external harness dependencies. See `THIRD_PARTY_LICENSES` for the original copyright and permission notice.
