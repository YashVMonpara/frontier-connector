<div align="center">

# Frontier Connector

**Claude and OpenAI. One direct local connector.**

An open-source, zero-dependency Node.js connector and OpenAI/Anthropic-compatible API gateway that lets any app, SDK, editor, or local script connect directly to your Claude and OpenAI subscriptions.

[![CI](https://github.com/YashVMonpara/frontier-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/YashVMonpara/frontier-connector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-lime.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg)](tsconfig.json)

[Quick start](#quick-start) · [Connect external apps](#connect-external-apps) · [Programmatic SDK](#programmatic-sdk) · [Usage guide](docs/usage.md) · [Contributing](CONTRIBUTING.md)

</div>

## Why Frontier?

Frontier provides a clean, standalone bridge between your local applications and your Claude or OpenAI ChatGPT subscription—without any middleware agent harness or runtime npm dependencies:

- **Universal Local API Gateway (`/v1/*`)**: Exposes standard OpenAI Chat Completions (`/v1/chat/completions`), OpenAI Responses (`/v1/responses`), Anthropic Messages (`/v1/messages`), and `/v1/models` endpoints on `127.0.0.1`. Any app or SDK that supports a custom base URL works directly with both providers.
- **Programmatic TypeScript/ESM Client**: Import [`FrontierConnector`](src/connector.ts), [`ClaudeAdapter`](src/claude.ts), [`OpenAIAdapter`](src/openai.ts), or [`startGatewayServer`](src/gateway.ts) directly in Node.js apps.
- **Local Web UI + CLI**: Sign in via browser OAuth (PKCE S256), check subscription limits, chat directly with streaming Markdown/reasoning output, or run headless with `frontier serve`.
- **Safe Local Auth**: Private atomic credential files (`0600`), cross-process lockfiles for coordinated token rotation, and optional bearer/`x-api-key` protection for the local gateway.

**Status: experimental.** Subscription integrations use undocumented provider endpoints. Account access and protocol compatibility can change. This is an independent project, unaffiliated with OpenAI or Anthropic.

## Quick start

Requires **Node.js 22 or newer** and a Claude or OpenAI account.

```sh
git clone https://github.com/YashVMonpara/frontier-connector.git
cd frontier-connector
npm ci
npm run build
```

Sign in to one or both providers via CLI or the Web UI:

```sh
# Option A: Authenticate via CLI and run the headless API gateway
npm start -- auth login --provider claude
npm start -- auth login --provider openai
npm start -- serve

# Option B: Launch the local Web UI + API gateway together
npm run web
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317) to manage Connections, inspect usage, copy gateway endpoints, or chat directly.

## Connect external apps

Once `npm start -- serve` (or `npm run web`) is running on `http://127.0.0.1:4317`:

### OpenAI-compatible apps & SDKs

Point any OpenAI-compatible client (OpenAI SDK, Cursor, Continue, Cline, OpenCode, LangChain, Python scripts, curl) to:

- **Base URL:** `http://127.0.0.1:4317/v1`
- **API Key:** any placeholder (or your configured `--gateway-key` / `FRONTIER_GATEWAY_KEY`)
- **Models:** `claude-sonnet-5`, `claude-opus-5`, `gpt-4o`, `o3`, or explicit `claude/<model>` / `openai/<model>` prefixes

```sh
curl http://127.0.0.1:4317/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [{"role": "user", "content": "Hello from an external app!"}]
  }'
```

### Anthropic-compatible apps & SDKs

Point Anthropic SDKs or Claude-compatible tools to:

- **Base URL (`ANTHROPIC_BASE_URL`):** `http://127.0.0.1:4317`

```sh
curl http://127.0.0.1:4317/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello via Anthropic API!"}]
  }'
```

## Programmatic SDK

```ts
import { FrontierConnector, createUserMessage } from 'frontier-connector'

const connector = new FrontierConnector()

const reply = await connector.generate({
  model: 'claude-sonnet-5', // or 'gpt-4o' / 'openai/gpt-4o'
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Explain PKCE briefly.' }] })],
})

console.log(reply.text)
```

For full CLI commands, configuration, OAuth/Keychain import details, and endpoint specs, see the [usage guide](docs/usage.md) and [architecture map](docs/architecture.md).

## Project structure

```text
src/
  auth/          OAuth PKCE login, private credential stores, Claude Code import, locked token refresh
  http/          Chat validation and OpenAI/Anthropic gateway protocol translators
  translate/     Anthropic Messages, OpenAI Responses, SSE framing, inline image plumbing
  types.ts       Self-contained message, stream chunk, tool, and error vocabulary
  claude.ts      Claude subscription & API-key adapter
  openai.ts      OpenAI ChatGPT subscription adapter
  connector.ts   Unified multi-provider router & programmatic client
  gateway.ts     Standalone HTTP API gateway (/v1/chat/completions, /v1/messages, /v1/responses, /v1/models)
  web-server.ts  Local Web UI + embedded API gateway server
  cli.ts         CLI entry point (auth, models, usage, chat, serve, web)
  index.ts       Public package exports
web/             Browser interface and styles
test/            Mocked provider, auth, connector, gateway, and web integration tests
docs/            Usage and architecture guides
scripts/         Release/package verification
```

## Credentials and limitations

- Zero runtime npm dependencies (`node_modules` runtime footprint is empty; pure Node.js 22+).
- Claude credentials default to `~/.config/frontier-connector/auth.json`; OpenAI uses `~/.config/frontier-connector/auth.json.openai`. Token files use mode `0600`; directories use `0700`.
- The gateway and web server bind to `127.0.0.1` by default, validate `Host` headers against DNS rebinding, and block unauthorized cross-origin browser requests.
- For vulnerability reporting, see [SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
npm run verify
```

The test suite covers credential isolation, refresh concurrency, OAuth callbacks, request authentication, stream framing, tool-call translation, connector routing, HTTP API gateway protocols, cancellation, and independent logout. Tests use temporary files and mocked provider responses; no live account is required. CI runs on Node 22 and 24.

## License and credits

Released under the [MIT license](LICENSE), copyright © 2026 Yash Monpara.

Provider wire translation modules were adapted from [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions/tree/1a2777ca2c68dd4e3c08072b97b9ab36e98bfa9b) (MIT). Original copyright and permission notices are retained in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
