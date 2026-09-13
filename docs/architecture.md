# Implementation map

`src/index.ts` registers the `ClaudeAdapter` with DSH and disposes its registration when the plugin unloads. `src/cli.ts` provides explicit auth commands and one-turn streaming without a running DSH profile.

```text
DSH registerAdapter / CLI
       |
       v
ClaudeAdapter
  |-- TokenManager -> locked TokenStore -> refresh grant / linked source
  |-- resolveImages -> message + tool + system translation
  |-- POST /v1/messages -> SSE framing -> DSH StreamChunks
  |-- GET /v1/models (optional discovery)
  `-- GET /api/oauth/usage (subscription only)
```

## Files

| Module | Responsibility |
| --- | --- |
| `auth/oauth.ts` | PKCE, callback listener, state validation, token exchange and refresh |
| `auth/store.ts` | Versioned store, permissions, atomic replacement and transaction locks |
| `auth/source.ts` | Explicit Keychain/file import and file refresh synchronization |
| `auth/manager.ts` | Re-read current source, preemptive refresh, rejected-token recovery |
| `claude.ts` | DSH contract, credentials/headers, request body, catalog, usage, streaming |
| `transport.ts` | HTTP error classification, reset parsing, cancellable waits, watchdog |
| `translate/anthropic.ts` | Request translation, cache markers and SSE event state machine |
| `translate/sse.ts` | Incremental framing and upstream cancellation on iterator exit |
| `translate/resolved.ts` | Attachment references to inline image bytes |

## Differences from the supplied teardown

- The reference checked at commit `1a2777ca2c68dd4e3c08072b97b9ab36e98bfa9b` uses a static Claude catalog by default. This connector also defaults to a static catalog, with explicit live discovery available. Capabilities not observed or configured are not assumed.
- The token file belongs to this connector rather than modifying the original plugin's store. Import is explicit. Fresh logins have independent automatic refresh.
- Keychain imports are read-only at the source; Claude Code owns their refresh. File imports synchronize rotations back while preserving unrelated fields. A compare-before-write check detects an already-changed token, but cannot provide an atomic transaction with the official CLI.
- The default rate-limit waiting budget is one minute and one retry, configurable. No unknown reset is guessed. Transport errors, 5xx errors, and in-band SSE errors are surfaced without automatic replay.
- HTTP 401s can be retried before streaming starts. An error after chunks were emitted ends that stream to avoid duplicated visible content or tool calls.
- The standalone CLI displays tool calls; DSH executes them. No local HTTP gateway is exposed.
- API-key mode uses a distinct header and system-prompt path. It never silently substitutes for subscription auth.

## Provenance

`translate/anthropic.ts`, `translate/sse.ts`, `translate/resolved.ts`, and `translate/responses.ts` derive from the reference's corresponding MIT-licensed files. Local changes add the API-key system-prompt path, initial text/thinking handling, zero-argument tool normalization, an SSE event size bound, cancellation cleanup, and connector-specific error text. See `THIRD_PARTY_LICENSES` for the original copyright and permission notice.

## Local web providers

`web-server.ts` serves the local interface and routes requests to independent Claude and OpenAI adapters. `auth/openai.ts` implements ChatGPT OAuth and locked token refresh; `openai.ts` discovers account models and translates the subscription Responses stream. Each provider has a separate credential store and logout state. The web app does not execute tool calls.
