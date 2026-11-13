# Usage guide

Requires **Node.js 22 or newer**.

```sh
npm ci
npm run build
```

## Authentication

### Browser OAuth login

```sh
npm start -- auth login --provider claude
npm start -- auth login --provider openai
```

`auth login` prints an authorization URL. Open it in your browser; the localhost callback completes the login. If the redirect cannot reach the terminal, paste the **full callback URL** into the prompt. State validation is required; bare authorization codes are not accepted.

### Importing an existing Claude Code session

```sh
npm start -- auth import
npm start -- auth status --provider all
```

On macOS, import checks the `Claude Code-credentials` Keychain item, then falls back to `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`. An explicit `--file /path/to/.credentials.json` selects a file directly.

## Running the API Gateway for External Apps

Start the headless gateway so any external app can connect directly to your Claude and OpenAI subscriptions:

```sh
npm start -- serve --port 4317
```

To require a local bearer / `x-api-key` token on `/v1/*` requests:

```sh
npm start -- serve --port 4317 --gateway-key my-local-secret
```

### Supported Endpoints

| Endpoint | Protocol | Compatibility |
| --- | --- | --- |
| `GET /health`, `GET /v1/health` | JSON | Connection health check (no secrets) |
| `GET /v1/models`, `GET /v1/models/:id` | OpenAI Models JSON | Lists connected Claude & OpenAI models |
| `POST /v1/chat/completions` | OpenAI Chat Completions (JSON & SSE) | OpenAI SDK, Cursor, Continue, Cline, OpenCode, curl |
| `POST /v1/responses` | OpenAI Responses (JSON & SSE) | OpenAI Responses API clients |
| `POST /v1/messages` | Anthropic Messages (JSON & SSE) | Anthropic SDK & Claude-compatible clients |

Responses streaming emits content, reasoning-summary, and function-call lifecycle events for OpenAI SDK stream accumulation. When generation reaches its output-token limit, both JSON and SSE responses report `status: "incomplete"` with `incomplete_details.reason: "max_output_tokens"`.

### Tool selection

OpenAI Chat Completions and Responses requests support `tool_choice: "auto"` (the default) and `tool_choice: "none"`. Anthropic Messages requests use `{ "type": "auto" }` or `{ "type": "none" }`. Selecting `none` removes tool definitions before invoking the provider. Required/forced tool choices, named tool choices, and additional Anthropic tool-choice options return `400`; these restrictions are never silently discarded.

### Model Routing Rules

- Prefix explicitly with `claude/<model-id>` or `openai/<model-id>` (or pass header `x-frontier-provider: claude|openai`).
- Unprefixed `claude*` models route to Claude; `gpt*`, `o1*`, `o3*`, `o4*`, `codex*`, and `chatgpt*` route to OpenAI.

## Running the Local Web UI

The local Web UI includes Connection management, subscription usage meters, direct streaming chat, conversation export/import, and mounts the `/v1/*` gateway routes on the same port:

```sh
npm run web
```

Open **http://127.0.0.1:4317**.

Logging out a provider disables both Web UI chat and the embedded gateway for that provider, including API-key mode, and cancels its active requests. Reconnect in the Web UI to enable it again. This does not revoke credentials in official provider apps or modify an API key in your environment.

## CLI Reference

```sh
npm start -- auth status --provider all
npm start -- auth logout --provider openai
npm start -- models --provider all
npm start -- models --provider claude --discover
npm start -- usage --provider claude
npm start -- chat "Hello" --provider claude --model claude-sonnet-5
npm start -- chat "Hello" --provider openai --model gpt-4o --json
npm start -- serve --port 4317 --gateway-key secret
npm start -- --help
```

`--api-key` uses `ANTHROPIC_API_KEY` for Claude without reading subscription credentials.

## Library Usage

```ts
import { FrontierConnector, startGatewayServer, createUserMessage } from 'frontier-connector'

const connector = new FrontierConnector()

for await (const chunk of connector.stream({
  model: 'openai/gpt-4o',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello!' }] })],
})) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
}

// Or embed the HTTP gateway directly:
const { server, url } = await startGatewayServer({ port: 4317, connector })
```
