# Implementation map

`src/index.ts` registers the Claude and OpenAI adapters with DSH and disposes both registrations when the plugin unloads. `src/runtime/harness.ts` owns one official SDK-profile subprocess per active browser conversation, exported through the stable `src/agent-runtime.ts` facade. `src/runtime/activity.ts` translates SDK notifications into bounded UI events. `src/http/chat.ts` validates incoming conversations and constructs agent prompts. `src/cli.ts` provides explicit Claude auth commands and one-turn streaming without a running DSH profile.

```text
Browser -> HarnessAgentRuntime -> `dsh --profile sdk`
                              |-- agent loop / tools / sandbox / sessions
                              |-- skills / goals / subagents / compaction
                              `-- ClaudeAdapter or OpenAIAdapter

ClaudeAdapter
  |-- TokenManager -> locked TokenStore -> refresh grant / linked source
  `-- Anthropic messages -> SSE -> DSH StreamChunks

OpenAIAdapter
  |-- OpenAITokens -> locked provider-specific store -> refresh grant
  `-- Responses input + function tools -> SSE -> DSH StreamChunks
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
- The standalone CLI displays tool calls; the embedded web runtime and externally hosted DSH profiles execute them.
- API-key mode uses a distinct header and system-prompt path. It never silently substitutes for subscription auth.

## Provenance

`translate/anthropic.ts`, `translate/sse.ts`, `translate/resolved.ts`, and `translate/responses.ts` derive from the reference's corresponding MIT-licensed files. Local changes add the API-key system-prompt path, initial text/thinking handling, zero-argument tool normalization, an SSE event size bound, cancellation cleanup, and connector-specific error text. See `THIRD_PARTY_LICENSES` for the original copyright and permission notice.

## Local web providers

`web-server.ts` serves the local interface and sends each chat turn to `HarnessAgentRuntime`. That manager starts the official `sdk` profile with `frontier-agent.patch.yml`, pins the chosen provider/model route, and reuses its durable session across turns. The profile owns the agent loop, file and shell tools, sandbox policy, skills, goals, subagents, and compaction. Stopping a turn reaps that conversation's subprocess because SDK `0.1.5-rc.2` has no mid-turn cancel method.

`auth/openai.ts` implements ChatGPT OAuth and locked token refresh; `openai.ts` discovers account models, maps Harness function schemas into Responses tools, and translates text, reasoning, function calls, usage, and terminal events back into DSH stream chunks. Each provider has a separate credential store and logout state. Logging out also closes that provider's resident Harness processes so credentials do not remain in an idle child.
