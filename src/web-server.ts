import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createAssistantMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ClaudeAdapter } from './claude.js'
import type { ConnectorOptions } from './claude.js'
import { TokenStore, atomicPrivateWrite } from './auth/store.js'
import { beginLogin } from './auth/oauth.js'
import type { LoginAttempt } from './auth/oauth.js'
import { beginOpenAILogin, openaiStore } from './auth/openai.js'
import { OpenAIAdapter } from './openai.js'
import type { OpenAIOptions } from './openai.js'

type Provider = 'claude' | 'openai'
function providerOf(value: unknown): Provider {
  if (value === undefined) return 'claude'
  if (value !== 'claude' && value !== 'openai') throw new RequestError('Unknown provider.')
  return value
}
interface LoginJob { state: 'starting' | 'waiting' | 'connected' | 'error'; attempt?: LoginAttempt; error?: string }


interface ChatInput {
  provider?: Provider
  model: string
  messages: { role: 'user' | 'assistant'; text: string }[]
  system?: string
  maxTokens?: number
  effort?: string
}

interface WebOptions {
  port?: number
  config?: ConnectorOptions & { openai?: OpenAIOptions }
  adapter?: Pick<ClaudeAdapter, 'stream' | 'listModels' | 'resolveModel' | 'usage'>
  openaiAdapter?: Pick<ClaudeAdapter, 'stream' | 'listModels' | 'resolveModel' | 'usage'>
  loginFactory?: (provider: Provider) => Promise<LoginAttempt>
}

class RequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

function validateChat(value: unknown): ChatInput {
  if (!value || typeof value !== 'object') throw new RequestError('Invalid chat request.')
  const input = value as ChatInput
  providerOf(input.provider)
  if (typeof input.model !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.model)) throw new RequestError('Choose a valid model ID.')
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 200) throw new RequestError('A conversation must contain between 1 and 200 messages. Start a new chat for a longer conversation.')
  if (input.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 100_000)) throw new RequestError('Messages must contain text, with at most 100,000 characters each.')
  if (input.messages[0].role !== 'user' || input.messages.at(-1)?.role !== 'user') throw new RequestError('The conversation must begin and end with your message.')
  if (input.system !== undefined && (typeof input.system !== 'string' || input.system.length > 20_000)) throw new RequestError('Instructions must be under 20,000 characters.')
  if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 32768)) throw new RequestError('Response length must be between 1 and 32,768 tokens.')
  if (input.effort !== undefined && (typeof input.effort !== 'string' || input.effort.length > 32)) throw new RequestError('Invalid reasoning effort.')
  return input
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new RequestError('Expected JSON.', 415)
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > 1024 * 1024) throw new RequestError('Conversation exceeds the 1 MiB request limit. Start a new chat.', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new RequestError('Invalid JSON.') }
}

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value))
}

async function send(res: ServerResponse, value: unknown, signal: AbortSignal) {
  signal.throwIfAborted()
  if (res.destroyed) throw new Error('Browser disconnected.')
  if (res.write(JSON.stringify(value) + '\n')) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { res.off('drain', drained); res.off('close', closed); signal.removeEventListener('abort', closed) }
    const drained = () => { cleanup(); resolve() }
    const closed = () => { cleanup(); reject(new Error('Browser disconnected.')) }
    res.once('drain', drained); res.once('close', closed); signal.addEventListener('abort', closed, { once: true })
    if (signal.aborted || res.destroyed) closed()
  })
}

/** Loopback-only UI. Provider credentials never leave the Node process. */
export async function startWebServer(options: WebOptions = {}) {
  const port = options.port ?? 4317
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be between 0 and 65535.')
  const config = options.config ?? {}
  const adapter = options.adapter ?? new ClaudeAdapter(config)
  const store = new TokenStore(config.authFile)
  const openaiConfig = { ...config.openai, authFile: config.openai?.authFile ?? (config.authFile ? `${config.authFile}.openai` : undefined) }
  const openai = options.openaiAdapter ?? new OpenAIAdapter(openaiConfig)
  const adapters = { claude: adapter, openai }
  const stores = { claude: store, openai: openaiStore(openaiConfig.authFile) }
  if (stores.claude.path === stores.openai.path) throw new Error('Claude and OpenAI require separate credential files.')
  const logins = new Map<Provider, LoginJob>()
  const streams = new Map<AbortController, Provider>()
  const modeOf = (provider: Provider) => provider === 'claude' ? config.authMode ?? 'subscription' : 'subscription'
  const disabled = async (provider: Provider) => {
    try { await readFile(`${stores[provider].path}.web-disabled`); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  const connected = async (provider: Provider) => !await disabled(provider) && (modeOf(provider) === 'api-key'
    ? Boolean(config.apiKey ?? process.env.ANTHROPIC_API_KEY) : Boolean(await stores[provider].read()))
  const csrf = randomBytes(32).toString('hex')
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ])
  let origin = ''
  let active = 0
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    try {
      // Host validation prevents DNS rebinding; Origin + a per-launch nonce
      // prevent other websites from invoking the user's local subscription.
      if (req.headers.host !== new URL(origin).host ||
          (req.headers.origin && req.headers.origin !== origin) ||
          req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError('This app accepts requests from its own local page only.', 403)
      const path = new URL(req.url ?? '/', origin).pathname
      if (req.method === 'GET' && assets.has(path)) {
        const [name, type] = assets.get(path)!
        const file = fileURLToPath(new URL(`../web/${name}`, import.meta.url))
        res.writeHead(200, { 'content-type': type }).end(await readFile(file))
        return
      }
      if (req.method === 'GET' && path === '/api/status') {
        const providers = {} as Record<Provider, object>
        for (const provider of ['claude', 'openai'] as const) {
          try {
            const mode = modeOf(provider), credential = mode === 'subscription' ? await stores[provider].read() : undefined
            const ready = await connected(provider)
            let models: { id: string; name: string; efforts: unknown[] }[] = [], modelError: string | undefined
            if (ready) {
              try {
                const list = await adapters[provider].listModels(provider)
                models = await Promise.all(list.map(async m => {
                  const resolved = await adapters[provider].resolveModel(provider, m.id)
                  return { id: m.id, name: m.name, efforts: [...(resolved.reasoning?.efforts ?? [])] }
                }))
              } catch (error) { modelError = error instanceof Error ? error.message : 'Model list unavailable.' }
            }
            const login = logins.get(provider)
            providers[provider] = { connected: ready, mode, source: credential?.source?.kind ?? (ready ? mode : null),
              expiresAt: credential ? new Date(credential.expiresAt).toISOString() : null, models, modelError,
              login: login ? { state: login.state, error: login.error } : null }
          } catch (error) { providers[provider] = { connected: false, mode: modeOf(provider), models: [], error: error instanceof Error ? error.message : 'Connection unavailable.' } }
        }
        json(res, { csrf, ...providers.claude, providers })
        return
      }
      const routes = ['/api/chat', '/api/usage', '/api/auth/login', '/api/auth/logout', '/api/auth/cancel', '/api/auth/callback']
      if (req.method !== 'POST' || !routes.includes(path)) throw new RequestError('Not found.', 404)
      const token = req.headers['x-frontier-token']
      if (typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(csrf) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) throw new RequestError('Refresh this page to reconnect.', 403)
      if (path.startsWith('/api/auth/')) {
        const body = await readJson(req) as { provider?: unknown; callback?: unknown }
        const provider = providerOf(body?.provider), target = stores[provider]
        if (path === '/api/auth/callback') {
          if (typeof body.callback !== 'string' || !logins.get(provider)?.attempt?.submitCallback(body.callback)) throw new RequestError('Invalid callback URL or state.')
          json(res, { accepted: true }); return
        }
        if (path === '/api/auth/cancel' || path === '/api/auth/logout') {
          const job = logins.get(provider); logins.delete(provider); job?.attempt?.cancel()
          if (path === '/api/auth/cancel' && job && ['starting', 'waiting'].includes(job.state)) await target.clear()
          if (path === '/api/auth/logout') {
            for (const [controller, owner] of streams) if (owner === provider) controller.abort(new Error('Logged out.'))
            // Persist disabling for API-key mode without modifying environment secrets.
            await atomicPrivateWrite(`${target.path}.web-disabled`, true)
            await target.clear()
            if (provider === 'openai' && openai instanceof OpenAIAdapter) openai.invalidate()
          }
          json(res, { ok: true }); return
        }
        if (modeOf(provider) === 'api-key') {
          await rm(`${target.path}.web-disabled`, { force: true }); json(res, { connected: true }); return
        }
        if (await connected(provider)) throw new RequestError('Already connected. Log out first to change accounts.', 409)
        if (['starting', 'waiting'].includes(logins.get(provider)?.state ?? '')) throw new RequestError('A login is already in progress. Finish it or cancel first.', 409)
        const job: LoginJob = { state: 'starting' }; logins.set(provider, job)
        try {
          const attempt = await (options.loginFactory ? options.loginFactory(provider) : provider === 'claude' ? beginLogin() : beginOpenAILogin())
          if (logins.get(provider) !== job) { attempt.cancel(); json(res, { cancelled: true }); return }
          job.attempt = attempt; job.state = 'waiting'
          void attempt.result.then(async session => {
            await target.locked(async () => {
              if (logins.get(provider) !== job) return
              await target.write(session)
              // Recheck after the write before enabling a concurrently cancelled login.
              if (logins.get(provider) === job) await rm(`${target.path}.web-disabled`, { force: true })
            })
            if (logins.get(provider) === job) { job.state = 'connected'; job.attempt = undefined }
          }).catch(error => { if (logins.get(provider) === job) { job.state = 'error'; job.error = error instanceof Error ? error.message : 'Sign-in failed.'; job.attempt = undefined } })
          json(res, { url: attempt.url }); return
        } catch (error) { if (logins.get(provider) === job) { job.state = 'error'; job.error = error instanceof Error ? error.message : 'Sign-in failed.' } throw error }
      }
      if (path === '/api/usage') {
        const provider = providerOf(new URL(req.url!, origin).searchParams.get('provider') ?? undefined)
        if (!await connected(provider)) throw new RequestError('Connect this provider first.', 401)
        json(res, await adapters[provider].usage()); return
      }
      const input = validateChat(await readJson(req))
      const provider = providerOf(input.provider)
      if (!await connected(provider)) throw new RequestError('Connect this provider in settings to chat.', 401)
      if (active >= 4) throw new RequestError('Four responses are already running. Stop one and try again.', 429)
      const abort = new AbortController()
      const disconnect = () => abort.abort(new Error('Browser disconnected.'))
      res.once('close', disconnect)
      active++; streams.set(abort, provider)
      try {
        const request: GenerateOptions = {
          provider, model: input.model, signal: abort.signal,
          system: input.system, maxTokens: input.maxTokens ?? 4096,
          ...(input.effort ? { reasoningEffort: ReasoningEffortId(input.effort) } : {}),
          messages: input.messages.map(m => m.role === 'user'
            ? createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: m.text }] })
            : createAssistantMessage({ source: { provider, model: input.model }, content: [{ type: 'text', text: m.text }] })),
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'x-accel-buffering': 'no' })
        res.flushHeaders()
        for await (const chunk of adapters[provider].stream(request)) {
          await send(res, chunk, abort.signal)
        }
      } catch (error) {
        if (!abort.signal.aborted && !res.destroyed) {
          // The adapter's HTTP/auth errors omit provider response bodies and tokens.
          await send(res, { type: 'error', message: error instanceof Error ? error.message : 'The response failed. Please try again.' }, abort.signal)
        }
      } finally { active--; streams.delete(abort); res.off('close', disconnect); res.end() }
    } catch (error) {
      if (!res.destroyed && !res.headersSent) json(res, { error: error instanceof Error ? error.message : 'Request failed.' }, error instanceof RequestError ? error.status : 500)
      else res.end()
    }
  })
  server.on('close', () => { for (const job of logins.values()) job.attempt?.cancel(); logins.clear(); for (const controller of streams.keys()) controller.abort() })
  server.requestTimeout = 30_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { server, url: origin }
}
