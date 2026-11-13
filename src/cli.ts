#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { ReasoningEffortId, createUserMessage } from './types.js'
import { ClaudeAdapter, DEFAULT_MODELS } from './claude.js'
import type { ConnectorOptions } from './claude.js'
import { TokenStore } from './auth/store.js'
import { beginLogin } from './auth/oauth.js'
import { beginOpenAILogin, openaiStore } from './auth/openai.js'
import { OpenAIAdapter } from './openai.js'
import type { OpenAIOptions } from './openai.js'
import { importClaudeCode } from './auth/source.js'

const help = `Frontier connector — Standalone Claude & OpenAI subscription connector & API gateway

Usage (after npm run build):
  npm start -- auth login [--provider claude|openai]       Browser OAuth login
  npm start -- auth import [--file PATH]                   Link an existing Claude Code session
  npm start -- auth status [--provider claude|openai|all]  Show expiry and source, never tokens
  npm start -- auth logout [--provider claude|openai]      Delete the connector's local session
  npm start -- models [--provider claude|openai|all] [--discover]
                                                           List configured or live models
  npm start -- usage [--provider claude|openai]            Show subscription usage JSON
  npm start -- chat "Your prompt" [options]                Stream one response
  npm start -- serve [--port N] [--host HOST] [--gateway-key KEY]
                                                           Start OpenAI/Anthropic-compatible API gateway
  npm run web [-- --port N] [-- --gateway-key KEY]         Open the local UI + API gateway

Options:
  --provider NAME     Provider: claude, openai, or all (for status/models; default: claude)
  --model ID          Model ID (default: ${DEFAULT_MODELS[0].id} for Claude, gpt-4o for OpenAI)
  --api-key           Use ANTHROPIC_API_KEY instead of a subscription (Claude only)
  --auth-file PATH    Alternate private token file
  --config PATH       Connector options JSON (models, timeouts, headers)
  --system TEXT       System instructions
  --max-tokens N      Output token limit (default 4096)
  --effort VALUE      Configured reasoning effort
  --json              Emit stream chunks as newline-delimited JSON
  --port N            Server port (default 4317)
  --host HOST         Server bind host for serve (default 127.0.0.1)
  --gateway-key KEY   Bearer / x-api-key required by /v1/* endpoints. Prefer the
                      FRONTIER_GATEWAY_KEY env var: flags are visible in ps and
                      shell history. Required when --host is not loopback.
  --help              Show this help

OAuth login prints a browser URL and accepts a full callback URL as fallback.
Imported file sessions sync refreshes back to their source. Imported Keychain
sessions are refreshed by Claude Code. Logout does not revoke provider tokens.
`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
      'api-key': { type: 'boolean' }, discover: { type: 'boolean' },
      file: { type: 'string' }, 'auth-file': { type: 'string' },
      config: { type: 'string' }, model: { type: 'string' }, system: { type: 'string' },
      'max-tokens': { type: 'string' }, effort: { type: 'string' },
      port: { type: 'string' }, host: { type: 'string' },
      'gateway-key': { type: 'string' }, provider: { type: 'string' },
    },
  })
  if (values.help || !positionals.length) { console.log(help); return }
  let config: ConnectorOptions & { openai?: OpenAIOptions } = {}
  if (values.config) {
    try { config = JSON.parse(await readFile(values.config, 'utf8')) }
    catch { throw new Error('Cannot read connector config JSON.') }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Config must be a JSON object.')
  }
  if (values['auth-file']) config.authFile = values['auth-file']
  if (values['api-key']) config.authMode = 'api-key'
  if (values.discover) config.discovery = true

  const rawProvider = values.provider?.toLowerCase()
  const provider: 'claude' | 'openai' = rawProvider === 'openai' ? 'openai' : 'claude'
  const claudeStore = new TokenStore(config.authFile)
  const oaStore = openaiStore(config.openai?.authFile ?? (config.authFile ? `${config.authFile}.openai` : undefined))
  const store = provider === 'openai' ? oaStore : claudeStore

  const [command, ...args] = positionals
  const port = values.port ? Number(values.port) : 4317
  const gatewayKey = values['gateway-key']

  if (command === 'serve') {
    const { startGatewayServer } = await import('./gateway.js')
    const { server, url } = await startGatewayServer({
      config,
      port,
      host: values.host ?? '127.0.0.1',
      gatewayKey,
    })
    console.log(`Frontier API Gateway listening on ${url}`)
    console.log(`  OpenAI Base URL:    ${url}/v1`)
    console.log(`  Anthropic Base URL: ${url}`)
    console.log(`  Models Endpoint:    ${url}/v1/models`)
    if (gatewayKey || process.env.FRONTIER_GATEWAY_KEY) {
      console.log('  Gateway Auth:       Bearer / x-api-key enabled')
    }
    console.log('Press Ctrl+C to stop.')
    const stop = () => { server.close(); server.closeAllConnections() }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    return
  }

  if (command === 'web') {
    const { startWebServer } = await import('./web-server.js')
    const { server, url } = await startWebServer({ config, port, gatewayKey })
    console.log(`Frontier web app & API gateway: ${url}`)
    console.log(`  OpenAI Base URL:    ${url}/v1`)
    console.log(`  Anthropic Base URL: ${url}`)
    console.log('Uses your existing connector session. Press Ctrl+C to stop.')
    const stop = () => { server.close(); server.closeAllConnections() }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    return
  }

  if (command === 'auth') {
    if (args[0] === 'login') {
      const attempt = provider === 'openai' ? await beginOpenAILogin() : await beginLogin()
      console.log(`Open this URL in your browser:\n${attempt.url}\n\nWaiting for ${provider} login. You can also paste the full callback URL here.`)
      const input = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
      input.on('line', line => {
        if (line.trim() && !attempt.submitCallback(line.trim())) console.error('Invalid callback URL or state; login is still waiting.')
      })
      const cancel = () => attempt.cancel()
      process.once('SIGINT', cancel)
      process.once('SIGTERM', cancel)
      try { await store.save(await attempt.result); console.log(`${provider === 'openai' ? 'OpenAI' : 'Claude'} login saved.`) }
      finally { input.close(); process.off('SIGINT', cancel); process.off('SIGTERM', cancel) }
    } else if (args[0] === 'import') {
      if (provider === 'openai') throw new Error('Session import is only supported for Claude Code.')
      await store.save(await importClaudeCode(values.file))
      console.log('Claude Code session linked. Use auth status to see expiry and source.')
    } else if (args[0] === 'logout') {
      await store.clear(); console.log(`${provider === 'openai' ? 'OpenAI' : 'Claude'} session removed.`)
    } else if (args[0] === 'status') {
      const targets: ('claude' | 'openai')[] = rawProvider === 'all' ? ['claude', 'openai'] : [provider]
      const statuses = await Promise.all(targets.map(async p => {
        const s = await (p === 'openai' ? oaStore : claudeStore).read()
        return s ? {
          provider: p, authenticated: true, expired: s.expiresAt <= Date.now(), expiresAt: new Date(s.expiresAt).toISOString(),
          source: s.source?.kind ?? 'oauth', authFile: (p === 'openai' ? oaStore : claudeStore).path,
        } : { provider: p, authenticated: false, authFile: (p === 'openai' ? oaStore : claudeStore).path }
      }))
      console.log(JSON.stringify(targets.length === 1 ? statuses[0] : statuses, null, 2))
    } else throw new Error('Use auth login, import, status, or logout.')
    return
  }

  const claudeAdapter = new ClaudeAdapter(config)
  const openaiAdapter = new OpenAIAdapter({ authFile: oaStore.path, ...config.openai })
  if (command === 'models') {
    if (rawProvider === 'all') {
      const [c, o] = await Promise.all([
        claudeAdapter.listModels('claude').catch(() => []),
        openaiAdapter.listModels('openai').catch(() => []),
      ])
      console.log(JSON.stringify([...c, ...o], null, 2))
      return
    }
    const adapter = provider === 'openai' ? openaiAdapter : claudeAdapter
    console.log(JSON.stringify(await adapter.listModels(provider), null, 2))
    return
  }

  const adapter = provider === 'openai' ? openaiAdapter : claudeAdapter
  if (command === 'usage') { console.log(JSON.stringify(await adapter.usage(), null, 2)); return }
  if (command !== 'chat') throw new Error(`Unknown command: ${command}. Use --help.`)
  const prompt = args.join(' ')
  if (!prompt.trim()) throw new Error('Provide a prompt: frontier chat "Hello"')
  const abort = new AbortController()
  const cancel = () => abort.abort(new Error('Cancelled.'))
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    const defaultModel = provider === 'openai' ? 'gpt-4o' : (config.models?.[0]?.id ?? DEFAULT_MODELS[0].id)
    for await (const chunk of adapter.stream({
      provider, model: values.model ?? defaultModel,
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
      system: values.system, signal: abort.signal,
      ...(values['max-tokens'] ? { maxTokens: Number(values['max-tokens']) } : {}),
      ...(values.effort ? { reasoningEffort: ReasoningEffortId(values.effort) } : {}),
    })) {
      if (values.json) console.log(JSON.stringify(chunk))
      else if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
      else if (chunk.type === 'reasoning-delta') process.stderr.write(chunk.text)
      else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') console.error('\nTool call:', JSON.stringify(chunk.block))
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
    }
    if (!values.json) console.log()
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel) }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Connector failed.'); process.exitCode = 1 })
