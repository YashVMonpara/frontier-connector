<div align="center">

# Frontier Connector

**Claude and OpenAI. One local workspace.**

An open-source DeepSeek Harness agent workspace that routes Claude and OpenAI subscription models from your own machine.

[![CI](https://github.com/YashVMonpara/frontier-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/YashVMonpara/frontier-connector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-lime.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg)](tsconfig.json)

[Quick start](#quick-start) · [Use cases](#use-cases) · [Core technology](#core-technology) · [Usage guide](docs/usage.md) · [Contributing](CONTRIBUTING.md)

</div>

## Why Frontier?

Frontier brings Claude and OpenAI ChatGPT connections into a single browser workspace served by your own Node.js process. Each browser conversation runs through the official DeepSeek Harness SDK profile, so the selected model gets the Harness agent loop, workspace files, shell, skills, goals, subagents, durable sessions, and compaction. Developers can also use the one-turn Claude CLI or mount either provider adapter in another DSH composition.

The source exposes the full path from OAuth sign-in through token refresh, request translation, and streaming output. It is useful both as a small daily chat interface and as a reference for building provider adapters.

**Status: experimental.** Subscription integrations use undocumented provider endpoints. Account access and protocol compatibility can change. This is an independent project, unaffiliated with OpenAI, Anthropic, or DeepSeek.

## Use cases

| What you want to do | How Frontier helps |
| --- | --- |
| Ask an agent to inspect or change a local project | The complete DSH runtime supplies file, shell, policy, session, and agent-loop services. |
| Write, brainstorm, or discuss code with different models | Select Claude or OpenAI as the model behind the same Harness agent interface. |
| Try the same question with different providers | Create separate conversations, choose each provider, and compare the replies yourself. |
| Keep a personal chat workspace on your machine | Run the web server locally; conversations and settings stay in browser storage. Prompts still go to the selected provider. |
| Query Claude from a terminal | Send a one-turn prompt with the CLI and optionally emit structured stream chunks using `--json`. |
| Add subscription models to another DSH workflow | Register the Claude and OpenAI routes; let the host composition manage tools, attachments, and turns. |
| Study or extend an AI connector | Follow the TypeScript implementations of PKCE, locked token refresh, SSE parsing, and provider message translation. |

## Quick start

Requires **Node.js 22 or newer**, npm, and a provider account with access to the selected models.

```sh
git clone https://github.com/YashVMonpara/frontier-connector.git
cd frontier-connector
npm ci
npm run web
```

Open [localhost:4317](http://127.0.0.1:4317), then:

1. Open **Connections** and choose **Connect** for Claude or OpenAI.
2. Follow browser sign-in. If needed, paste the full callback URL into the connection panel.
3. Select the provider and model beside the message composer.
4. Send a prompt. Use **Log out** on either connection to disconnect that provider from Frontier.

For Claude API keys, CLI commands, credential import, custom ports, configuration, and DSH installation, see the [usage guide](docs/usage.md).

## Features and scope

| Capability | Local web app | CLI / DSH |
| --- | --- | --- |
| Claude subscription connection | Yes | Yes |
| OpenAI ChatGPT subscription connection | Yes | Registered `openai` adapter route |
| Claude API-key authentication | Yes, explicitly configured | Yes |
| Markdown/code response display | Yes, after the agent turn reaches idle | Stream chunks / terminal text |
| Conversation history | Browser storage plus durable DSH sessions | One-turn CLI; DSH owns its history |
| Provider and model selection | Yes | `claude` and `openai` routes |
| Custom instructions and reasoning controls | Yes, subject to provider/model support | Adapter options |
| Stop, copy, and regenerate | Yes; stopping reaps that conversation's runtime | Cancellation available to adapter callers |
| Agent loop and tool execution | Yes: files, shell, skills, goals, subagents, compaction | Yes |
| Live Harness activity | Expandable steps, tool inputs, outputs, errors, retries, and subagent lifecycle | Session events |
| Image attachments | No browser upload control yet | Adapter/SDK message support |
| Independent provider logout | Yes | Claude CLI logout |

OpenAI models are discovered from the connected account. Claude uses a configurable catalog with optional live discovery. A model appearing in a catalog does not guarantee your account can use it. The OpenAI subscription endpoint does not accept the web app's response-length setting.

## Core technology

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Runtime | Node.js 22+, TypeScript 5.9, ES modules | Local server, CLI, provider adapters |
| Agent runtime | `@deepseek-ai/dsh-sdk-client` + DSH SDK profile | Agent loop, tools, sandbox policy, sessions, skills, goals, subagents, compaction |
| Interface | HTML, CSS, vanilla JavaScript | Responsive chat, model controls, Markdown rendering |
| Local HTTP | Node.js HTTP server | Loopback-only server, origin/Host checks, request nonce validation |
| Authentication | OAuth with PKCE S256 and random state | Browser authorization and validated loopback callbacks |
| Credential storage | Local JSON, private atomic writes, filesystem locks | Separate provider sessions and coordinated refresh |
| Transport | Fetch, Web Streams, AbortSignal | Provider requests, cancellation, idle watchdogs |
| Streaming | Provider SSE → DSH events → browser NDJSON | Provider/tool events and final agent response |
| Harness integration | DSH `0.1.5-rc.2`, SDK profile, `@deepseek-ai/dsh-llm`, Cordis | Complete local agent process plus both adapter routes |
| Verification | Node.js test runner, GitHub Actions | Mocked provider tests on Node 22 and 24 |

### Request flow

```text
Browser conversation
        │
        ▼
Local Node.js server
        │ starts one SDK-profile process per active conversation
        ▼
DeepSeek Harness agent runtime
  ├── agent loop + durable session
  ├── file/shell tools + workspace sandbox
  ├── skills + goals + subagents + compaction
  └── selected `claude` or `openai` adapter
             │
             ▼
Provider credential store + locked refresh
             │
             ▼
Selected provider endpoint → SSE → DSH events
             │
             ▼
Final agent response → browser NDJSON
```

“Local” describes where the interface, server, and stored state run. Inference is performed by the remote provider. See the [implementation map](docs/architecture.md) for source-level detail.

## Project structure

```text
src/
  auth/          OAuth, credential stores, imports, token refresh
  claude.ts      Claude provider adapter
  openai.ts      OpenAI ChatGPT provider adapter
  agent-runtime.ts  Stable runtime exports for embedding
  runtime/       Harness process ownership and activity translation
  http/          Chat validation and agent prompt construction
  translate/     Provider request and stream translation
  web-server.ts  Local HTTP endpoints and connection lifecycle
  cli.ts         Claude CLI and web-server entry point
  index.ts       Library exports and DSH plugin registration
web/             Browser interface and styles
test/            Mocked provider and local integration tests
docs/            Usage and architecture guides
scripts/         Release/package verification
```

## Credentials and limitations

- Claude credentials default to `~/.config/frontier-connector/auth.json`; OpenAI uses the adjacent `auth.json.openai` file. Token files use mode `0600`; newly created credential directories use `0700`.
- Each provider has separate connection state. Web logout stops its active responses and clears its connector session, preserving chats and the other provider. It does not revoke remote tokens or sign out official apps.
- Chat history is browser local storage. Clearing that storage removes it. There is no cloud sync, multi-user access control, or account pooling.
- Harness session logs stay under `~/.config/frontier-connector/harness`. The connector disables DSH telemetry for these web sessions.
- The embedded SDK transport cannot present interactive approval prompts. Workspace reads and writes run under DSH's `workspace-write` sandbox; operations that require an unavailable approval fail closed.
- The web server binds to `127.0.0.1`. It is not designed for direct public hosting or exposure through a tunnel.
- Imported Claude Code Keychain sessions remain owned by Claude Code. File imports can synchronize refreshed credentials back to the source; read the [import guidance](docs/usage.md) before sharing a credential file across clients.
- Review your provider's terms before using subscription integrations. No API-key fallback happens automatically. Tests do not guarantee live subscription compatibility.

For vulnerability reporting, see [SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
npm run verify
```

The test suite covers credential isolation, refresh concurrency, OAuth callbacks, request authentication, stream framing, tool-call translation, the agent-runtime bridge, cancellation, and independent logout. Tests use temporary files and mocked provider responses; no live account is required. CI runs on Node 22 and 24.

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), open an issue with a reproducible example, or submit a focused pull request with relevant tests.

Development targets `main`. See the [changelog](CHANGELOG.md) and
[release process](docs/releasing.md) for release preparation and validation.

## License and credits

Released under the [MIT license](LICENSE), copyright © 2026 Yash Monpara.

Provider translation code was adapted from [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions/tree/1a2777ca2c68dd4e3c08072b97b9ab36e98bfa9b). Original copyright and permission notices are retained in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
