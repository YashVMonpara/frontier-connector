import { execFileSync } from 'node:child_process'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { TokenManager } from './auth/manager.js'
import { TokenStore } from './auth/store.js'
import type { Fetch } from './auth/oauth.js'
import { markMessageCache, streamAnthropic, toAnthropicMessages, toAnthropicSystem, toAnthropicTools } from './translate/anthropic.js'
import { resolveImages } from './translate/resolved.js'
import type { TranslatableMessage } from './translate/resolved.js'
import { HttpError, idleWatchdog, retryDelay, sleep } from './transport.js'

export const BETA_FLAGS = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,effort-2025-11-24,compact-2026-01-12,files-api-2025-04-14'
export interface Model {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  thinking?: 'adaptive' | 'enabled'
  efforts?: string[]
}

export interface ConnectorOptions {
  authMode?: 'subscription' | 'api-key'
  apiKey?: string
  authFile?: string
  models?: Model[]
  discovery?: boolean
  cliVersion?: string
  betaFlags?: string
  streamIdleTimeoutMs?: number
  maxRateLimitWaitMs?: number
  maxRateLimitRetries?: number
  fetchFn?: Fetch
  tokens?: TokenManager
  resolveAttachments?: () => AttachmentStore | undefined
}

interface CatalogModel {
  id: string
  display_name?: string
  capabilities?: {
    thinking?: { types?: { adaptive?: { supported?: boolean }; enabled?: { supported?: boolean } } }
    effort?: Record<string, { supported?: boolean } | boolean>
  }
}

export const DEFAULT_MODELS: Model[] = [
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-fable-5', name: 'Claude Fable 5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
]

function cliVersion(): string {
  try {
    const output = execFileSync('claude', ['--version'], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return output.match(/^(\d+\.\d+\.\d+)/)?.[1] ?? '2.1.234'
  } catch { return '2.1.234' }
}

export function requestBody(options: GenerateOptions, messages: readonly TranslatableMessage[], model: Model, subscription: boolean) {
  const maxTokens = options.maxTokens ?? model.maxTokens ?? 4096
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('maxTokens must be a positive integer.')
  const wire = toAnthropicMessages(messages)
  if (!wire.length) throw new Error('At least one user or assistant message is required.')
  markMessageCache(wire)
  const effort = options.reasoningEffort
  if (effort && !model.efforts?.includes(effort)) throw new Error(`Reasoning effort is not configured for ${model.id}.`)
  let thinking: Record<string, unknown> | undefined
  if (effort && model.thinking === 'adaptive') thinking = { type: 'adaptive', display: 'summarized' }
  if (effort && model.thinking === 'enabled') {
    if (maxTokens <= 1024) throw new Error('Thinking requires maxTokens greater than 1024.')
    thinking = { type: 'enabled', budget_tokens: Math.min(maxTokens - 1, 8192), display: 'summarized' }
  }
  if (thinking && options.temperature !== undefined && options.temperature !== 1) throw new Error('Thinking requires temperature 1 or unset.')
  if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 1)) throw new Error('temperature must be between 0 and 1.')
  return {
    model: options.model, max_tokens: maxTokens,
    system: toAnthropicSystem(options.system, messages, subscription), messages: wire,
    ...(options.tools?.length ? { tools: toAnthropicTools(options.tools) } : {}),
    ...(thinking ? { thinking } : {}),
    ...(effort ? { output_config: { effort } } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stop?.length ? { stop_sequences: options.stop } : {}),
    stream: true,
  }
}

export class ClaudeAdapter extends LlmAdapter {
  readonly tokens: TokenManager
  private readonly fetchFn: Fetch
  private readonly subscription: boolean
  private version?: string
  private catalog?: { models: Model[]; expires: number }
  private catalogPending?: Promise<Model[]>

  constructor(private readonly config: ConnectorOptions = {}) {
    super()
    if (config.authMode !== undefined && config.authMode !== 'subscription' && config.authMode !== 'api-key') throw new Error('authMode must be subscription or api-key.')
    if (config.models !== undefined && (!Array.isArray(config.models) || config.models.some(m => !m || typeof m.id !== 'string' || !m.id || (m.efforts !== undefined && (!Array.isArray(m.efforts) || m.efforts.some(e => typeof e !== 'string')))))) throw new Error('models must contain valid model IDs and effort strings.')
    this.subscription = (config.authMode ?? 'subscription') === 'subscription'
    this.fetchFn = config.fetchFn ?? fetch
    this.tokens = config.tokens ?? new TokenManager(new TokenStore(config.authFile), this.fetchFn)
    for (const [name, value] of Object.entries({ streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 60_000, maxRateLimitWaitMs: config.maxRateLimitWaitMs ?? 60_000, maxRateLimitRetries: config.maxRateLimitRetries ?? 1 })) {
      if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value) || (name === 'streamIdleTimeoutMs' && value === 0)) throw new Error(`Invalid ${name}.`)
    }
  }

  override providerInfo(provider: string) { return { id: provider, name: this.subscription ? 'Claude (Frontier subscription)' : 'Claude (Frontier API)' } }

  private async headers(rejected?: string): Promise<Headers> {
    const headers = new Headers({ 'anthropic-version': '2023-06-01', 'content-type': 'application/json' })
    if (this.subscription) {
      const session = await this.tokens.session(rejected)
      this.version ??= this.config.cliVersion ?? cliVersion()
      headers.set('authorization', `Bearer ${session.accessToken}`)
      headers.set('user-agent', `claude-cli/${this.version} (external, cli)`)
      headers.set('x-app', 'cli')
      headers.set('anthropic-beta', this.config.betaFlags ?? BETA_FLAGS)
      headers.set('anthropic-dangerous-direct-browser-access', 'true')
    } else {
      const key = this.config.apiKey ?? process.env.ANTHROPIC_API_KEY
      if (!key) throw new Error('Set ANTHROPIC_API_KEY for API-key mode.')
      headers.set('x-api-key', key)
      headers.set('user-agent', 'frontier-connector/0.1.0')
    }
    return headers
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    let headers = await this.headers()
    let refreshed = false
    let retries = 0
    let waited = 0
    for (;;) {
      signal.throwIfAborted()
      headers.set('accept', path.startsWith('/v1/messages') ? 'text/event-stream' : 'application/json')
      const response = await this.fetchFn(`https://api.anthropic.com${path}`, { ...init, headers, signal, redirect: 'error' })
      if (response.status === 401 && this.subscription && !refreshed) {
        await response.body?.cancel()
        refreshed = true
        headers = await this.headers(headers.get('authorization')!.slice(7))
        continue
      }
      if (response.ok) return response
      const wait = response.status === 429 ? retryDelay(response.headers) : undefined
      await response.body?.cancel()
      if (response.status === 429 && wait !== undefined &&
          retries < (this.config.maxRateLimitRetries ?? 1) &&
          waited + wait <= (this.config.maxRateLimitWaitMs ?? 60_000)) {
        retries++; waited += wait
        await sleep(wait, signal)
        continue
      }
      throw new HttpError(response.status, wait)
    }
  }

  private async catalogModels(): Promise<Model[]> {
    const fallback = this.config.models ?? DEFAULT_MODELS
    if (!(this.config.discovery ?? false)) return fallback
    if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.models
    if (this.catalogPending) return this.catalogPending
    this.catalogPending = (async () => {
      const models: Model[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({ limit: '100', ...(this.subscription ? { beta: 'true' } : {}), ...(cursor ? { after_id: cursor } : {}) })
        const response = await this.request(`/v1/models?${query}`, { method: 'GET' }, AbortSignal.timeout(30_000))
        const data = await response.json() as { data?: CatalogModel[]; has_more?: boolean; last_id?: string }
        if (!Array.isArray(data.data) || data.data.some(m => !m || typeof m.id !== 'string' || !m.id)) throw new Error('Invalid Claude model catalog.')
        for (const m of data.data) {
          const types = m.capabilities?.thinking?.types
          const thinking = types?.adaptive?.supported ? 'adaptive' : types?.enabled?.supported ? 'enabled' : undefined
          const effort = m.capabilities?.effort
          const efforts = effort?.supported === true ? ['low', 'medium', 'high', 'xhigh', 'max'].filter(id => {
            const value = effort[id]
            return typeof value === 'object' && value?.supported === true
          }) : []
          models.push({ ...fallback.find(entry => entry.id === m.id), id: m.id, name: m.display_name ?? m.id,
            ...(thinking ? { thinking } : {}), ...(efforts.length ? { efforts } : {}) })
        }
        if (!data.has_more) { this.catalog = { models, expires: Date.now() + 300_000 }; return models }
        if (!data.last_id || data.last_id === cursor) throw new Error('Invalid Claude model pagination cursor.')
        cursor = data.last_id
      }
      throw new Error('Claude catalog exceeded 20 pages.')
    })()
    try { return await this.catalogPending } finally { this.catalogPending = undefined }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.subscription && !await this.tokens.store.read()) return []
    if (!this.subscription && !(this.config.apiKey ?? process.env.ANTHROPIC_API_KEY)) return []
    return (await this.catalogModels()).map(m => ({ provider, id: m.id, name: m.name ?? m.id, inputModalities: ['text', 'image'] }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = (this.catalog?.models ?? this.config.models ?? DEFAULT_MODELS).find(m => m.id === model)
    return {
      provider, id: model, name: entry?.name ?? model, inputModalities: ['text', 'image'],
      defaultMaxTokens: entry?.maxTokens ?? 4096,
      ...(entry?.contextWindow ? { context: { contextWindow: entry.contextWindow } } : {}),
      ...(entry?.efforts?.length ? { reasoning: { efforts: entry.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })) } } : {}),
    }
  }

  async usage(): Promise<unknown> {
    if (!this.subscription) throw new Error('Subscription usage is unavailable in API-key mode.')
    const response = await this.request('/api/oauth/usage', { method: 'GET' }, AbortSignal.timeout(30_000))
    return response.json()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const messages = await resolveImages(options.messages, this.config.resolveAttachments?.(), options.signal)
    if (this.config.discovery) await this.catalogModels()
    const model = (this.catalog?.models ?? this.config.models ?? DEFAULT_MODELS).find(m => m.id === options.model) ?? { id: options.model }
    const body = JSON.stringify(requestBody(options, messages, model, this.subscription))
    // Allow bounded rate-limit waits before arming the stream idle watchdog.
    const headerController = new AbortController()
    const headerTimer = setTimeout(() => headerController.abort(new Error('Claude request timed out.')), 40_000 + (this.config.maxRateLimitWaitMs ?? 60_000))
    const requestSignal = options.signal ? AbortSignal.any([options.signal, headerController.signal]) : headerController.signal
    let response: Response
    try {
      response = await this.request(`/v1/messages${this.subscription ? '?beta=true' : ''}`, { method: 'POST', body }, requestSignal)
    } finally { clearTimeout(headerTimer) }
    if (!response.body) throw new LlmError('Claude response has no body.', 'MALFORMED_RESPONSE')
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body.cancel()
      throw new LlmError('Expected a Claude SSE response.', 'MALFORMED_RESPONSE')
    }
    const watchdog = idleWatchdog(options.signal, this.config.streamIdleTimeoutMs ?? 60_000)
    // Cancel the body even for injected fetch implementations that ignore AbortSignal.
    const reader = response.body.getReader()
    let abortReason: unknown
    const abort = () => { abortReason = watchdog.signal.reason; void reader.cancel(abortReason).catch(() => {}) }
    watchdog.signal.addEventListener('abort', abort, { once: true })
    if (watchdog.signal.aborted) abort()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (abortReason) { controller.error(abortReason); return }
          if (next.done) controller.close()
          else { watchdog.touch(); controller.enqueue(next.value) }
        } catch (error) { controller.error(error) }
      },
      cancel: reason => reader.cancel(reason),
    })
    try { yield* streamAnthropic(stream, watchdog.touch) }
    finally {
      watchdog.signal.removeEventListener('abort', abort)
      watchdog.close()
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}
