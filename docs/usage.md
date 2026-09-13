# Usage guide

## Try it

Requires Node.js 22 or newer.

```sh
npm ci
npm run build
npm start -- auth login
npm start -- chat "Explain how an adapter works"
```

`auth login` prints an authorization URL. Open it in your browser; the localhost callback completes the login. If the automatic redirect cannot reach the terminal, paste the **full callback URL** into that terminal. State validation is required; bare authorization codes are not accepted.

To use a session already owned by Claude Code:

```sh
npm start -- auth import
npm start -- auth status
npm start -- chat "Hello"
```

On macOS, import checks the `Claude Code-credentials` Keychain item, then falls back to `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`. An explicit `--file /absolute/path/to/.credentials.json` selects a file directly.

**Keychain refresh:** imported Keychain sessions remain owned by Claude Code. When they expire, run Claude Code and retry. The connector re-reads that source. Use `auth login` for independent automatic refresh. Imported **file** sessions refresh automatically and sync the rotated credentials back to the source file; avoid running two different clients that refresh that file concurrently.

## Web app

After connecting, start the browser interface:

```sh
npm run web
```

Open **http://127.0.0.1:4317**. The app reuses your connector session and provides streamed multi-turn chat, model selection, Markdown/code rendering, copy and regenerate actions, stop controls, custom instructions, and subscription usage. Conversations and settings stay in this browser's local storage; credentials stay in the Node process. Clearing browser storage clears those conversations.

Open **Connections** to connect Claude or OpenAI using browser sign-in. Select the provider beside the model picker before sending a message. OpenAI uses your ChatGPT subscription connection and discovers the models available to that account. Its response-length control is disabled because the subscription endpoint does not accept that setting.

Each provider has its own **Log out** button. Logout stops that provider's active responses and removes only its connector session; saved conversations and the other provider remain available. It does not sign out Claude Code, Codex, or your browser account. OpenAI credentials use an adjacent `auth.json.openai` file (or `openai.authFile` in configuration). A `.web-disabled` marker persists web logout, including for configured Claude API keys; reconnect through Connections to enable access again.

For a custom configuration, API-key mode, or another local port:

```sh
npm run web -- --config connector.example.json
npm run web -- --api-key --port 4320
```

The interface is a local, text-chat workspace. Tool execution and image attachments remain available through the DSH adapter, not through this web UI. It binds only to `127.0.0.1`; remote hosting requires a separate authentication and deployment design.

## CLI commands

```sh
npm start -- auth status
npm start -- auth logout
npm start -- models
npm start -- models --discover
npm start -- usage
npm start -- chat "Hello" --model claude-sonnet-5 --max-tokens 4096
npm start -- chat "Hello" --system "Be concise" --json
npm start -- chat "Hello" --api-key
npm start -- --help
```

API-key mode reads `ANTHROPIC_API_KEY` from the environment. It does not fall back from subscription auth automatically, so a failed subscription request cannot unexpectedly incur API charges.

`--json` emits DSH stream chunks as newline-delimited JSON. The CLI sends one turn and prints returned tool calls; it does **not** execute tools or maintain conversation history. The DSH host owns tool execution and subsequent turns.

`usage` returns the provider's raw subscription usage JSON, preserving both legacy and newer response layouts. `models` uses the reference repository's static catalog snapshot; `--discover` explicitly queries the provider with pagination and a five-minute in-memory cache. Catalog membership does not guarantee account access. Supply `--model` to use a different model ID.

## DSH plugin

This package targets the published `@deepseek-ai/dsh-llm@0.1.2-alpha.3` contract and `@deepseek-ai/cordis@4.0.2`. It registers route `claude`; choose a different route if another adapter already owns it.

Build and install the local package into your compatible DSH profile:

```sh
npm pack
dsh plugin --profile web add ./dsh-plugin-frontier-connector-0.1.0.tgz
```

The included `cordis.patch.yml` mounts the plugin. Authenticate through the CLI under the same operating-system user as DSH. Restart the profile after changing login state if its model picker caches the prior list. The standalone web app provides connection settings; the DSH host manages its own interface.

For a manually managed composition, configure the plugin entry with:

```yaml
- name: dsh-plugin-frontier-connector
  config:
    route: claude
    authMode: subscription
    streamIdleTimeoutMs: 60000
    maxRateLimitWaitMs: 60000
    maxRateLimitRetries: 1
```

Do not mount both this manual entry and the bundled patch. Images use `ctx.attachments.readImage()`; requests carrying image references fail explicitly if the host has no attachment service.

## Configuration and library use

The CLI accepts `--config connector.example.json`; DSH accepts the same adapter options plus `route`. See [the configuration example](../connector.example.json). Reasoning capabilities can be configured per model or learned through `discovery: true`. Effort is sent only when that model advertises the requested value.

```ts
import { ClaudeAdapter } from 'dsh-plugin-frontier-connector'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const adapter = new ClaudeAdapter({ authMode: 'subscription' })
for await (const chunk of adapter.stream({
  provider: 'claude',
  model: 'claude-sonnet-5',
  messages: [createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Hello' }],
  })],
})) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
}
```

