import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpenAITokens, openaiStore } from './auth/openai.js'
import type { Fetch } from './auth/oauth.js'
import { streamResponses, toResponsesInput } from './translate/responses.js'
import { idleWatchdog } from './transport.js'

export interface OpenAIOptions { authFile?: string; fetchFn?: Fetch; streamIdleTimeoutMs?: number; clientVersion?: string }
export class OpenAIAdapter extends LlmAdapter {
  readonly tokens: OpenAITokens
  private readonly fetchFn: Fetch
  private catalog?: { expires: number; models: LlmResolvedModelInfo[] }
  constructor(private readonly config: OpenAIOptions = {}) {
    super(); this.fetchFn = config.fetchFn ?? fetch; this.tokens = new OpenAITokens(openaiStore(config.authFile), this.fetchFn)
  }
  override providerInfo(provider: string) { return { id: provider, name: 'OpenAI (ChatGPT)' } }
  invalidate() { this.catalog = undefined }
  private async request(path: string, init: RequestInit, signal: AbortSignal) {
    for (let attempt = 0, rejected: string | undefined; ; attempt++) {
      signal.throwIfAborted()
      const session = await this.tokens.session(rejected)
      signal.throwIfAborted()
      const response = await this.fetchFn(`https://chatgpt.com${path}`, {
        ...init, signal, redirect: 'error', headers: {
          authorization: `Bearer ${session.accessToken}`, 'chatgpt-account-id': session.accountId!, originator: 'codex_cli_rs',
          'user-agent': 'frontier-connector/0.1.0', 'content-type': 'application/json', accept: init.method === 'POST' ? 'text/event-stream' : 'application/json',
        },
      })
      if (response.status === 401 && attempt === 0) { rejected = session.accessToken; await response.body?.cancel(); continue }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenAI request failed (HTTP ${response.status}).${response.status === 429 ? ' Your account is rate limited; try again later.' : ''}`) }
      return response
    }
  }
  override async listModels(provider: string): Promise<LlmResolvedModelInfo[]> {
    if (!await this.tokens.store.read()) return []
    if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.models.map(m => ({ ...m, provider }))
    const response = await this.request(`/backend-api/codex/models?client_version=${encodeURIComponent(this.config.clientVersion ?? '0.153.4')}`, { method: 'GET' }, AbortSignal.timeout(30_000))
    const data = await response.json() as { models?: { slug: string; display_name?: string; visibility?: string; supported_reasoning_levels?: { effort: string; description?: string }[] }[] }
    if (!Array.isArray(data.models)) throw new Error('OpenAI returned an invalid model list.')
    const models = data.models.filter(m => typeof m.slug === 'string' && m.visibility !== 'hide' && m.visibility !== 'none').map(m => ({
      provider, id: m.slug, name: m.display_name || m.slug,
      reasoning: { efforts: (m.supported_reasoning_levels ?? []).filter(e => typeof e.effort === 'string').map(e => ({ id: ReasoningEffortId(e.effort), name: e.effort })) },
    }))
    this.catalog = { models, expires: Date.now() + 300_000 }; return models
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.catalog?.models.find(m => m.id === model) ?? { provider, id: model, name: model }
  }
  async usage() { return (await this.request('/backend-api/wham/usage', { method: 'GET' }, AbortSignal.timeout(30_000))).json() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const resolved = toResponsesInput(options.messages, options.system)
    const body = { model: options.model, instructions: resolved.instructions || 'You are a helpful assistant.', input: resolved.input,
      stream: true, store: false, include: ['reasoning.encrypted_content'],
      ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort, summary: 'auto' } } : {}),
    }
    // Codex subscription requests do not accept max_output_tokens.
    const watchdog = idleWatchdog(options.signal, this.config.streamIdleTimeoutMs ?? 60_000)
    try {
      const response = await this.request('/backend-api/codex/responses', { method: 'POST', body: JSON.stringify(body) }, watchdog.signal)
      // The subscription gateway can omit or mislabel the SSE content type.
      // Validate the actual events (including response.completed) in the parser.
      if (!response.body) throw new Error('OpenAI returned an empty response body.')
      yield* streamResponses(response.body, watchdog.touch)
    } finally { watchdog.close() }
  }
}
