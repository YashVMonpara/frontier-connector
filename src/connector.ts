import { ClaudeAdapter } from './claude.js'
import type { ConnectorOptions } from './claude.js'
import { OpenAIAdapter } from './openai.js'
import type { OpenAIOptions } from './openai.js'
import { TokenStore } from './auth/store.js'
import { openaiStore } from './auth/openai.js'
import type {
  ConnectorAdapter,
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  ProviderId,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
} from './types.js'

export interface FrontierConfig extends ConnectorOptions {
  openai?: OpenAIOptions
}

export interface FrontierConnectorOptions {
  config?: FrontierConfig
  claude?: ConnectorAdapter
  openai?: ConnectorAdapter
}

export interface GenerateResult {
  provider: ProviderId
  model: string
  text: string
  reasoning: string
  toolCalls: ToolCallBlock[]
  blocks: ContentBlock[]
  usage?: TokenUsage
  finishReason: FinishReason
}

export interface ProviderConnectionStatus {
  connected: boolean
  mode: 'subscription' | 'api-key'
  source: string | null
  expiresAt: string | null
}

/**
 * Standalone multi-provider connector routing directly to Claude and OpenAI
 * subscription (or Claude API-key) endpoints with no middleware harness.
 */
export class FrontierConnector {
  readonly claude: ConnectorAdapter
  readonly openai: ConnectorAdapter
  readonly stores: { claude: TokenStore; openai: TokenStore }
  readonly config: FrontierConfig

  constructor(options: FrontierConnectorOptions = {}) {
    const config = options.config ?? {}
    this.config = config
    const claudeAuthFile = config.authFile
    const openaiAuthFile = config.openai?.authFile ?? (config.authFile ? `${config.authFile}.openai` : undefined)
    this.stores = {
      claude: new TokenStore(claudeAuthFile),
      openai: openaiStore(openaiAuthFile),
    }
    if (this.stores.claude.path === this.stores.openai.path) {
      throw new Error('Claude and OpenAI require separate credential files.')
    }
    this.claude = options.claude ?? new ClaudeAdapter(config)
    this.openai = options.openai ?? new OpenAIAdapter({
      ...config.openai,
      authFile: openaiAuthFile,
      resolveAttachments: config.openai?.resolveAttachments ?? config.resolveAttachments,
    })
  }

  adapter(provider: ProviderId): ConnectorAdapter {
    return provider === 'openai' ? this.openai : this.claude
  }

  async isConnected(provider: ProviderId): Promise<boolean> {
    if (provider === 'claude' && this.config.authMode === 'api-key') {
      return Boolean(this.config.apiKey ?? process.env.ANTHROPIC_API_KEY)
    }
    return Boolean(await this.stores[provider].read())
  }

  async status(): Promise<Record<ProviderId, ProviderConnectionStatus>> {
    const claudeMode = this.config.authMode ?? 'subscription'
    const claudeCred = claudeMode === 'subscription' ? await this.stores.claude.read() : undefined
    const claudeReady = claudeMode === 'api-key'
      ? Boolean(this.config.apiKey ?? process.env.ANTHROPIC_API_KEY)
      : Boolean(claudeCred)
    const openaiCred = await this.stores.openai.read()
    return {
      claude: {
        connected: claudeReady,
        mode: claudeMode,
        source: claudeCred?.source?.kind ?? (claudeReady ? claudeMode : null),
        expiresAt: claudeCred ? new Date(claudeCred.expiresAt).toISOString() : null,
      },
      openai: {
        connected: Boolean(openaiCred),
        mode: 'subscription',
        source: openaiCred ? 'oauth' : null,
        expiresAt: openaiCred ? new Date(openaiCred.expiresAt).toISOString() : null,
      },
    }
  }

  resolveTarget(model: string, explicitProvider?: ProviderId): { provider: ProviderId; model: string } {
    if (model.startsWith('claude/')) return { provider: 'claude', model: model.slice('claude/'.length) }
    if (model.startsWith('openai/')) return { provider: 'openai', model: model.slice('openai/'.length) }
    if (model.startsWith('chatgpt/')) return { provider: 'openai', model: model.slice('chatgpt/'.length) }
    if (explicitProvider) return { provider: explicitProvider, model }
    if (/^(claude|anthropic)/i.test(model)) return { provider: 'claude', model }
    if (/^(gpt|o[1-9]|codex|chatgpt)/i.test(model)) return { provider: 'openai', model }
    return { provider: 'claude', model }
  }

  async listModels(provider?: ProviderId): Promise<LlmModelInfo[]> {
    const targets: ProviderId[] = provider ? [provider] : ['claude', 'openai']
    const results = await Promise.all(targets.map(async id => {
      try {
        return [...await this.adapter(id).listModels(id)]
      } catch {
        return []
      }
    }))
    return results.flat()
  }

  async usage(provider: ProviderId): Promise<unknown> {
    return this.adapter(provider).usage()
  }

  async *stream(
    options: Omit<GenerateOptions, 'provider'> & { provider?: ProviderId },
  ): AsyncIterable<StreamChunk> {
    const target = this.resolveTarget(options.model, options.provider)
    yield* this.adapter(target.provider).stream({
      ...options,
      provider: target.provider,
      model: target.model,
    })
  }

  async generate(
    options: Omit<GenerateOptions, 'provider'> & { provider?: ProviderId },
  ): Promise<GenerateResult> {
    const target = this.resolveTarget(options.model, options.provider)
    let text = ''
    let reasoning = ''
    const blocks: ContentBlock[] = []
    const toolCalls: ToolCallBlock[] = []
    let usage: TokenUsage | undefined
    let finishReason: FinishReason = { kind: 'stop' }

    for await (const chunk of this.stream({ ...options, provider: target.provider, model: target.model })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      else if (chunk.type === 'block-end') {
        blocks.push(chunk.block)
        if (chunk.block.type === 'tool-call') toolCalls.push(chunk.block)
      } else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') {
        finishReason = chunk.reason
        if (chunk.reason.kind === 'error') {
          throw new Error(chunk.reason.failure.message)
        }
      }
    }

    return {
      provider: target.provider,
      model: target.model,
      text,
      reasoning,
      toolCalls,
      blocks,
      ...(usage ? { usage } : {}),
      finishReason,
    }
  }
}
