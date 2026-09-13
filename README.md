<div align="center">

# Frontier Connector

**Claude and OpenAI. One local workspace.**

An open-source chat interface and provider adapter toolkit for developers who want to explore subscription-backed AI workflows from their own machine.

[![CI](https://github.com/YashVMonpara/frontier-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/YashVMonpara/frontier-connector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-lime.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg)](tsconfig.json)

[Quick start](#quick-start) · [Use cases](#use-cases) · [Core technology](#core-technology) · [Usage guide](docs/usage.md) · [Contributing](CONTRIBUTING.md)

</div>

## Why Frontier?

Frontier brings Claude and OpenAI ChatGPT connections into a single browser workspace served by your own Node.js process. Choose a provider and model, stream replies, and keep conversations in your browser. Developers can also use the Claude CLI or connect the Claude adapter to DeepSeek Harness (DSH).

The source exposes the full path from OAuth sign-in through token refresh, request translation, and streaming output. It is useful both as a small daily chat interface and as a reference for building provider adapters.

**Status: experimental.** Subscription integrations use undocumented provider endpoints. Account access and protocol compatibility can change. This is an independent project, unaffiliated with OpenAI, Anthropic, or DeepSeek.

## Use cases

| What you want to do | How Frontier helps |
| --- | --- |
| Write, brainstorm, or discuss code with different models | Select Claude or OpenAI and an available model in the same chat interface. |
| Try the same question with different providers | Create separate conversations, choose each provider, and compare the replies yourself. |
| Keep a personal chat workspace on your machine | Run the web server locally; conversations and settings stay in browser storage. Prompts still go to the selected provider. |
| Query Claude from a terminal | Send a one-turn prompt with the CLI and optionally emit structured stream chunks using `--json`. |
| Add Claude to a DSH workflow | Register the Claude adapter; let the harness manage tools, attachments, and subsequent turns. |
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
| OpenAI ChatGPT subscription connection | Yes | Exported adapter; no OpenAI CLI command or registered DSH route |
| Claude API-key authentication | Yes, explicitly configured | Yes |
| Streaming text and Markdown/code display | Yes | Stream chunks / terminal text |
| Conversation history | Browser local storage | One-turn CLI; DSH owns its history |
| Provider and model selection | Yes | Claude model selection |
| Custom instructions and reasoning controls | Yes, subject to provider/model support | Adapter options |
| Stop, copy, and regenerate | Yes | Cancellation available to adapter callers |
| Tool execution and image attachments | Not supported in the web UI | Claude adapter translates them; DSH executes tools and resolves images |
| Independent provider logout | Yes | Claude CLI logout |

OpenAI models are discovered from the connected account. Claude uses a configurable catalog with optional live discovery. A model appearing in a catalog does not guarantee your account can use it. The OpenAI subscription endpoint does not accept the web app's response-length setting.

## Core technology

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Runtime | Node.js 22+, TypeScript 5.9, ES modules | Local server, CLI, provider adapters |
| Interface | HTML, CSS, vanilla JavaScript | Responsive chat, model controls, Markdown rendering |
| Local HTTP | Node.js HTTP server | Loopback-only server, origin/Host checks, request nonce validation |
| Authentication | OAuth with PKCE S256 and random state | Browser authorization and validated loopback callbacks |
| Credential storage | Local JSON, private atomic writes, filesystem locks | Separate provider sessions and coordinated refresh |
| Transport | Fetch, Web Streams, AbortSignal | Provider requests, cancellation, idle watchdogs |
| Streaming | Server-Sent Events → DSH chunks → NDJSON | Incremental text, reasoning, usage, and completion events |
| Harness integration | `@deepseek-ai/dsh-llm`, Cordis | Claude adapter registration and message contracts |
| Verification | Node.js test runner, GitHub Actions | Mocked provider tests on Node 22 and 24 |

### Request flow

```text
Browser chat                  Claude CLI / DSH
     │                               │
     ▼                               │
Local Node.js server                 │
     │                               │
     ├── Claude adapter ◄────────────┘
     │      └── Anthropic message translation
     │
     └── OpenAI adapter
            └── Responses translation
                  │
       Provider-specific credential store
       + locked refresh + authenticated request
                  │
                  ▼
       Selected provider's remote endpoint
                  │
                  ▼
       SSE parser → normalized stream chunks
                  │
                  ▼
       Browser NDJSON / CLI output / DSH
```

“Local” describes where the interface, server, and stored state run. Inference is performed by the remote provider. See the [implementation map](docs/architecture.md) for source-level detail.

## Project structure

```text
src/
  auth/          OAuth, credential stores, imports, token refresh
  claude.ts      Claude provider adapter
  openai.ts      OpenAI ChatGPT provider adapter
  translate/     Provider request and stream translation
  web-server.ts  Local HTTP endpoints and connection lifecycle
  cli.ts         Claude CLI and web-server entry point
  index.ts       Library exports and DSH plugin registration
web/             Browser interface and styles
test/            Mocked provider and local integration tests
docs/            Usage and architecture guides
```

## Credentials and limitations

- Claude credentials default to `~/.config/frontier-connector/auth.json`; OpenAI uses the adjacent `auth.json.openai` file. Token files use mode `0600`; newly created credential directories use `0700`.
- Each provider has separate connection state. Web logout stops its active responses and clears its connector session, preserving chats and the other provider. It does not revoke remote tokens or sign out official apps.
- Chat history is browser local storage. Clearing that storage removes it. There is no cloud sync, multi-user access control, or account pooling.
- The web server binds to `127.0.0.1`. It is not designed for direct public hosting or exposure through a tunnel.
- Imported Claude Code Keychain sessions remain owned by Claude Code. File imports can synchronize refreshed credentials back to the source; read the [import guidance](docs/usage.md) before sharing a credential file across clients.
- Review your provider's terms before using subscription integrations. No API-key fallback happens automatically. Tests do not guarantee live subscription compatibility.

For vulnerability reporting, see [SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

The test suite covers credential isolation, refresh concurrency, OAuth callbacks, request authentication, stream framing, cancellation, translation, and independent logout. Tests use temporary files and mocked provider responses; no live account is required. CI runs on Node 22 and 24.

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), open an issue with a reproducible example, or submit a focused pull request with relevant tests.

## License and credits

Released under the [MIT license](LICENSE), copyright © 2026 Yash Monpara.

Provider translation code was adapted from [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions/tree/1a2777ca2c68dd4e3c08072b97b9ab36e98bfa9b). Original copyright and permission notices are retained in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
