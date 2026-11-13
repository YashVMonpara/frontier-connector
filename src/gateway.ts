import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { FrontierConnector } from './connector.js'
import type { FrontierConfig } from './connector.js'
import { RequestError } from './http/chat.js'
import {
  anthropicErrorPayload,
  anthropicStopReason,
  collectFullResponse,
  openAIErrorPayload,
  openAIFinishReason,
  parseAnthropicMessagesRequest,
  parseOpenAIChatRequest,
  parseResponsesRequest,
  toAnthropicUsage,
  toOpenAIUsage,
} from './http/gateway-translate.js'
import { LlmError } from './types.js'
import type { ConnectorAdapter, FinishReason, ProviderId, StreamChunk, TokenUsage } from './types.js'

export interface GatewayOptions {
  port?: number
  host?: string
  config?: FrontierConfig
  connector?: FrontierConnector
  claude?: ConnectorAdapter
  openai?: ConnectorAdapter
  gatewayKey?: string
  allowCorsOrigins?: readonly string[]
  maxBodyBytes?: number
  /** Maximum simultaneous inference requests; further requests get 429. */
  maxConcurrentRequests?: number
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8

export function isLoopbackAddress(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

function isWildcardAddress(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]'
}

function hostAuthority(host: string, port: number): string {
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
}

/**
 * Refuses configurations that would let other machines or arbitrary websites
 * spend the user's subscription without a gateway key.
 */
export function assertSafeExposure(host: string, gatewayKey: string | undefined, allowCorsOrigins: readonly string[] | undefined): void {
  if (gatewayKey) return
  if (!isLoopbackAddress(host)) {
    throw new Error(`Refusing to bind ${host} without a gateway key: other machines could use your subscription. Set FRONTIER_GATEWAY_KEY (or --gateway-key), or bind 127.0.0.1.`)
  }
  if (allowCorsOrigins?.includes('*')) {
    throw new Error('Refusing allowCorsOrigins "*" without a gateway key: any website could use your subscription.')
  }
}

function isAllowedHostHeader(hostHeader: string | undefined, boundHost: string, boundPort: number): boolean {
  if (!hostHeader) return false
  try {
    const parsed = new URL(`http://${hostHeader}`)
    const hostname = parsed.hostname
    const port = parsed.port ? Number(parsed.port) : 80
    if (port !== boundPort) return false
    if (isLoopbackAddress(boundHost)) return isLoopbackAddress(hostname)
    // Wildcard binds are reachable under any interface name; startup already
    // requires a gateway key for them, which is what blocks rebinding there.
    if (isWildcardAddress(boundHost)) return true
    const bare = (value: string) => value.replace(/^\[|\]$/g, '').toLowerCase()
    return bare(hostname) === bare(boundHost)
  } catch {
    return false
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function extractApiKey(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  const xApiKey = req.headers['x-api-key']
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    return xApiKey.trim()
  }
  return undefined
}

function explicitProviderHeader(req: IncomingMessage): ProviderId | undefined {
  const raw = req.headers['x-frontier-provider']
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  if (value === 'claude' || value === 'openai') return value
  throw new RequestError('x-frontier-provider must be claude or openai.')
}

async function readGatewayJson(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().includes('application/json')) {
    throw new RequestError('Expected application/json request body.', 415)
  }
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > maxBytes) {
      throw new RequestError(`Request body exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit.`, 413)
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError('Invalid JSON request body.')
  }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(payload))
}

async function writeSse(res: ServerResponse, chunk: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (res.destroyed) throw new Error('Client disconnected.')
  if (res.write(chunk)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      signal.removeEventListener('abort', onClose)
    }
    const onDrain = () => { cleanup(); resolve() }
    const onClose = () => { cleanup(); reject(new Error('Client disconnected.')) }
    res.once('drain', onDrain)
    res.once('close', onClose)
    signal.addEventListener('abort', onClose, { once: true })
    if (signal.aborted || res.destroyed) onClose()
  })
}

function errorStatus(error: unknown): number {
  if (error instanceof RequestError) return error.status
  if (error instanceof LlmError) {
    if (error.code === 'AUTH') return 401
    if (error.code === 'RATE_LIMIT') return 429
    if (error.code === 'TIMEOUT') return 504
    if (error.code === 'INVALID_REQUEST' || error.code === 'UNSUPPORTED' || error.code === 'CONTEXT_WINDOW_EXCEEDED') return 400
    return 502
  }
  return 500
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()
}

export interface GatewayContext {
  connector: FrontierConnector
  boundHost: string
  boundPort: number
  localOrigin?: string
  gatewayKey?: string
  allowCorsOrigins?: readonly string[]
  maxBodyBytes?: number
  /** Embedding servers supply their own readiness check (e.g. web logout). */
  isConnected?: (provider: ProviderId) => Promise<boolean>
  /** In-flight requests by provider, so an embedding server can cancel them on logout. */
  streams?: Map<AbortController, ProviderId>
  /** Shared in-flight counter; `max` bounds simultaneous inference requests. */
  limiter?: { active: number; max: number }
}

/**
 * Handles `/health` and `/v1/*` OpenAI & Anthropic compatible API routes.
 * Returns `true` if the route matched the gateway, `false` otherwise.
 */
export async function handleGatewayRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
): Promise<boolean> {
  let url: URL
  try {
    url = new URL(req.url ?? '/', `http://${hostAuthority(ctx.boundHost, ctx.boundPort)}`)
  } catch {
    writeJson(res, 400, openAIErrorPayload(new Error('Invalid request URL.'), 400))
    return true
  }
  const path = url.pathname
  const isGatewayPath = path === '/health' || path === '/v1/health' || path === '/v1/models' ||
    path.startsWith('/v1/models/') || path === '/v1/chat/completions' || path === '/v1/messages' || path === '/v1/responses'
  if (!isGatewayPath) return false

  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')

  if (!isAllowedHostHeader(req.headers.host, ctx.boundHost, ctx.boundPort)) {
    writeJson(res, 403, openAIErrorPayload(new Error('Invalid Host header.'), 403))
    return true
  }

  const origin = req.headers.origin
  if (origin) {
    const allowed = (ctx.localOrigin && origin === ctx.localOrigin) ||
      (ctx.allowCorsOrigins?.includes(origin) ?? false) ||
      (ctx.allowCorsOrigins?.includes('*') ?? false)
    if (!allowed) {
      writeJson(res, 403, openAIErrorPayload(new Error('Cross-origin browser requests are not allowed.'), 403))
      return true
    }
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'Origin')
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, anthropic-version, x-frontier-provider')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return true
  }

  const expectedKey = ctx.gatewayKey ?? process.env.FRONTIER_GATEWAY_KEY
  if (expectedKey) {
    const supplied = extractApiKey(req)
    if (!supplied || !safeEqual(supplied, expectedKey)) {
      const payload = path === '/v1/messages'
        ? anthropicErrorPayload(new Error('Invalid or missing gateway API key.'), 401)
        : openAIErrorPayload(new Error('Invalid or missing gateway API key.'), 401)
      writeJson(res, 401, payload)
      return true
    }
  }

  const isAnthropicEndpoint = path === '/v1/messages'
  const formatError = (error: unknown, status = errorStatus(error)) =>
    isAnthropicEndpoint ? anthropicErrorPayload(error, status) : openAIErrorPayload(error, status)
  const isConnected = (provider: ProviderId) =>
    ctx.isConnected ? ctx.isConnected(provider) : ctx.connector.isConnected(provider)

  try {
    if (req.method === 'GET' && (path === '/health' || path === '/v1/health')) {
      const status = await ctx.connector.status()
      for (const provider of ['claude', 'openai'] as const) {
        status[provider].connected = await isConnected(provider)
      }
      writeJson(res, 200, { ok: true, providers: status })
      return true
    }

    if (req.method === 'GET' && (path === '/v1/models' || path.startsWith('/v1/models/'))) {
      const explicit = explicitProviderHeader(req)
      const models = await ctx.connector.listModels(explicit)
      if (path.startsWith('/v1/models/')) {
        let modelId: string
        try { modelId = decodeURIComponent(path.slice('/v1/models/'.length)) } catch { throw new RequestError('Invalid model ID encoding.') }
        const match = models.find(m => m.id === modelId || `${m.provider}/${m.id}` === modelId)
        if (!match) {
          writeJson(res, 404, openAIErrorPayload(new Error(`Model '${modelId}' not found.`), 404))
          return true
        }
        writeJson(res, 200, {
          id: match.id,
          object: 'model',
          created: 0,
          owned_by: match.provider,
          provider: match.provider,
          name: match.name,
        })
        return true
      }
      writeJson(res, 200, {
        object: 'list',
        data: models.map(m => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: m.provider,
          provider: m.provider,
          name: m.name,
        })),
      })
      return true
    }

    if (req.method !== 'POST') {
      writeJson(res, 405, formatError(new Error('Method not allowed.'), 405))
      return true
    }

    const body = await readGatewayJson(req, ctx.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
    const explicit = explicitProviderHeader(req)
    const parsed = path === '/v1/chat/completions'
      ? parseOpenAIChatRequest(body, explicit)
      : path === '/v1/messages'
        ? parseAnthropicMessagesRequest(body, explicit)
        : parseResponsesRequest(body, explicit)

    const target = ctx.connector.resolveTarget(parsed.options.model, parsed.provider)
    const limiter = ctx.limiter
    if (limiter && limiter.active >= limiter.max) {
      throw new RequestError(`${limiter.max} gateway requests are already running. Retry shortly.`, 429)
    }

    // Register before any await so a disconnect or logout during the
    // connection check still cancels the request.
    const abort = new AbortController()
    const onDisconnect = () => abort.abort(new Error('Client disconnected.'))
    res.once('close', onDisconnect)
    ctx.streams?.set(abort, target.provider)
    if (limiter) limiter.active++

    try {
      if (!await isConnected(target.provider)) {
        throw new RequestError(`Provider '${target.provider}' is not connected. Run frontier auth login --provider ${target.provider}.`, 401)
      }
      abort.signal.throwIfAborted()
      // The target is already resolved: call the adapter directly so a model
      // like `openai/claude-x` is not re-parsed and routed to another provider.
      const stream = ctx.connector.adapter(target.provider).stream({
        ...parsed.options, provider: target.provider, model: target.model, signal: abort.signal,
      })

      if (!parsed.stream) {
        const result = await collectFullResponse(stream)
        if (path === '/v1/chat/completions') {
          writeJson(res, 200, {
            id: `chatcmpl_${randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: target.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: result.text || null,
                ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
                ...(result.toolCalls.length ? {
                  tool_calls: result.toolCalls.map(call => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments },
                  })),
                } : {}),
              },
              finish_reason: openAIFinishReason(result.finishReason),
            }],
            ...(result.usage ? { usage: toOpenAIUsage(result.usage) } : {}),
          })
          return true
        }
        if (path === '/v1/messages') {
          const content: Record<string, unknown>[] = []
          if (result.reasoning) content.push({ type: 'thinking', thinking: result.reasoning })
          if (result.text) content.push({ type: 'text', text: result.text })
          for (const call of result.toolCalls) {
            let parsedInput: unknown = {}
            try { parsedInput = JSON.parse(call.arguments) } catch { parsedInput = {} }
            content.push({ type: 'tool_use', id: call.id, name: call.name, input: parsedInput })
          }
          writeJson(res, 200, {
            id: `msg_${randomUUID()}`,
            type: 'message',
            role: 'assistant',
            model: target.model,
            content,
            stop_reason: anthropicStopReason(result.finishReason),
            stop_sequence: null,
            usage: result.usage ? toAnthropicUsage(result.usage) : { input_tokens: 0, output_tokens: 0 },
          })
          return true
        }
        // /v1/responses non-streaming
        const output: Record<string, unknown>[] = []
        if (result.reasoning) {
          output.push({ type: 'reasoning', id: `rs_${randomUUID()}`, summary: [{ type: 'summary_text', text: result.reasoning }] })
        }
        if (result.text) {
          output.push({
            type: 'message',
            id: `msg_${randomUUID()}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: result.text, annotations: [] }],
          })
        }
        for (const call of result.toolCalls) {
          output.push({
            type: 'function_call',
            id: `fc_${randomUUID()}`,
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
            status: 'completed',
          })
        }
        writeJson(res, 200, {
          id: `resp_${randomUUID()}`,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          ...responsesCompletion(result.finishReason),
          model: target.model,
          output,
          output_text: result.text,
          ...responsesUsage(result.usage),
        })
        return true
      }

      // Streaming responses
      if (path === '/v1/chat/completions') {
        await streamOpenAIChat(res, stream, target.model, parsed.includeUsage, abort.signal)
      } else if (path === '/v1/messages') {
        await streamAnthropicMessages(res, stream, target.model, abort.signal)
      } else {
        await streamResponsesApi(res, stream, target.model, abort.signal)
      }
      return true
    } finally {
      if (limiter) limiter.active--
      ctx.streams?.delete(abort)
      res.off('close', onDisconnect)
    }
  } catch (error) {
    if (!res.headersSent) {
      writeJson(res, errorStatus(error), formatError(error))
    } else if (!res.destroyed) {
      const status = errorStatus(error)
      const payload = isAnthropicEndpoint
        ? `event: error\ndata: ${JSON.stringify(anthropicErrorPayload(error, status))}\n\n`
        : `data: ${JSON.stringify(openAIErrorPayload(error, status))}\n\ndata: [DONE]\n\n`
      res.end(payload)
    }
    return true
  }
}

/** Last-resort handler so a bug in request handling answers 500 instead of crashing the process. */
export function failSafe(res: ServerResponse, error: unknown): void {
  console.error('Unhandled gateway error:', error instanceof Error ? error.message : error)
  if (!res.headersSent && !res.destroyed) writeJson(res, 500, openAIErrorPayload(new Error('Internal server error.'), 500))
  else res.destroy()
}

async function streamOpenAIChat(
  res: ServerResponse,
  stream: AsyncIterable<StreamChunk>,
  model: string,
  includeUsage: boolean,
  signal: AbortSignal,
): Promise<void> {
  const id = `chatcmpl_${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let headersWritten = false
  let roleSent = false
  const toolIndices = new Map<number, number>()
  const startedTools = new Set<number>()
  let nextToolIndex = 0
  let lastUsage: TokenUsage | undefined
  let sentFinish = false

  const emitChunk = async (delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown) => {
    if (!headersWritten) {
      sseHeaders(res)
      headersWritten = true
    }
    const payload: Record<string, unknown> = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }
    if (usage) payload.usage = usage
    await writeSse(res, `data: ${JSON.stringify(payload)}\n\n`, signal)
  }

  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      const delta: Record<string, unknown> = { content: chunk.text }
      if (!roleSent) { delta.role = 'assistant'; roleSent = true }
      await emitChunk(delta)
    } else if (chunk.type === 'reasoning-delta') {
      const delta: Record<string, unknown> = { reasoning_content: chunk.text }
      if (!roleSent) { delta.role = 'assistant'; roleSent = true }
      await emitChunk(delta)
    } else if (chunk.type === 'tool-call-delta') {
      let toolIndex = toolIndices.get(chunk.index)
      if (toolIndex === undefined) {
        toolIndex = nextToolIndex++
        toolIndices.set(chunk.index, toolIndex)
      }
      const firstForTool = !startedTools.has(chunk.index)
      startedTools.add(chunk.index)
      const toolDelta: Record<string, unknown> = {
        index: toolIndex,
        ...(firstForTool ? { id: chunk.id, type: 'function' } : {}),
        function: {
          ...(firstForTool && chunk.name ? { name: chunk.name } : {}),
          arguments: chunk.argumentsDelta,
        },
      }
      const delta: Record<string, unknown> = { tool_calls: [toolDelta] }
      if (!roleSent) { delta.role = 'assistant'; roleSent = true }
      await emitChunk(delta)
    } else if (chunk.type === 'usage') {
      lastUsage = chunk.usage
    } else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error') {
        throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code ?? 'SERVER')
      }
      sentFinish = true
      await emitChunk({}, openAIFinishReason(chunk.reason))
    }
  }

  if (!sentFinish) {
    await emitChunk({}, 'stop')
  }
  if (includeUsage && lastUsage) {
    if (!headersWritten) { sseHeaders(res); headersWritten = true }
    await writeSse(res, `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [],
      usage: toOpenAIUsage(lastUsage),
    })}\n\n`, signal)
  }
  await writeSse(res, 'data: [DONE]\n\n', signal)
  res.end()
}

async function streamAnthropicMessages(
  res: ServerResponse,
  stream: AsyncIterable<StreamChunk>,
  model: string,
  signal: AbortSignal,
): Promise<void> {
  const id = `msg_${randomUUID()}`
  let headersWritten = false
  let started = false
  let lastUsage: TokenUsage | undefined
  let stopReason = 'end_turn'

  const sendEvent = async (event: string, data: unknown) => {
    if (!headersWritten) { sseHeaders(res); headersWritten = true }
    await writeSse(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, signal)
  }

  const ensureStart = async () => {
    if (started) return
    started = true
    await sendEvent('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  const openToolStarted = new Set<number>()
  const openBlocks = new Set<number>()
  // Every delta must follow a content_block_start for its index, even when an
  // adapter streams deltas without announcing the block first.
  const ensureBlock = async (index: number, kind: 'text' | 'reasoning') => {
    await ensureStart()
    if (openBlocks.has(index)) return
    openBlocks.add(index)
    await sendEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
    })
  }
  for await (const chunk of stream) {
    if (chunk.type === 'block-start') {
      await ensureStart()
      if (chunk.blockType === 'text' || chunk.blockType === 'reasoning') await ensureBlock(chunk.index, chunk.blockType)
      // tool-call starts are deferred until first tool-call-delta so id & name are populated
    } else if (chunk.type === 'text-delta') {
      await ensureBlock(chunk.index, 'text')
      await sendEvent('content_block_delta', { type: 'content_block_delta', index: chunk.index, delta: { type: 'text_delta', text: chunk.text } })
    } else if (chunk.type === 'reasoning-delta') {
      await ensureBlock(chunk.index, 'reasoning')
      await sendEvent('content_block_delta', { type: 'content_block_delta', index: chunk.index, delta: { type: 'thinking_delta', thinking: chunk.text } })
    } else if (chunk.type === 'tool-call-delta') {
      await ensureStart()
      if (!openToolStarted.has(chunk.index)) {
        openToolStarted.add(chunk.index)
        await sendEvent('content_block_start', {
          type: 'content_block_start',
          index: chunk.index,
          content_block: { type: 'tool_use', id: chunk.id, name: chunk.name ?? '', input: {} },
        })
      }
      if (chunk.argumentsDelta) {
        await sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: chunk.index,
          delta: { type: 'input_json_delta', partial_json: chunk.argumentsDelta },
        })
      }
    } else if (chunk.type === 'block-end') {
      await ensureStart()
      if (chunk.block.type === 'text' || chunk.block.type === 'reasoning') await ensureBlock(chunk.index, chunk.block.type)
      if (chunk.block.type === 'tool-call' && !openToolStarted.has(chunk.index)) {
        openToolStarted.add(chunk.index)
        await sendEvent('content_block_start', {
          type: 'content_block_start',
          index: chunk.index,
          content_block: { type: 'tool_use', id: chunk.block.id, name: chunk.block.name, input: {} },
        })
      }
      await sendEvent('content_block_stop', { type: 'content_block_stop', index: chunk.index })
    } else if (chunk.type === 'usage') {
      lastUsage = chunk.usage
    } else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error') {
        throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code ?? 'SERVER')
      }
      stopReason = anthropicStopReason(chunk.reason)
    }
  }

  await ensureStart()
  await sendEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: lastUsage ? toAnthropicUsage(lastUsage) : { input_tokens: 0, output_tokens: 0 },
  })
  await sendEvent('message_stop', { type: 'message_stop' })
  res.end()
}

function responsesCompletion(reason: FinishReason) {
  if (reason.kind === 'aborted') throw new LlmError('Generation aborted.', 'STREAM_CLOSED')
  return reason.kind === 'max-tokens'
    ? { status: 'incomplete' as const, incomplete_details: { reason: 'max_output_tokens' } }
    : { status: 'completed' as const, incomplete_details: null }
}

function responsesUsage(usage: TokenUsage | undefined) {
  if (!usage) return {}
  const input = usage.inputTokens + (usage.cacheReadTokens ?? 0)
  return { usage: { input_tokens: input, output_tokens: usage.outputTokens, total_tokens: input + usage.outputTokens } }
}

/**
 * Streams the OpenAI Responses event sequence: created/in_progress, then per
 * item output_item.added -> part/summary added -> deltas -> done events, and a
 * terminal completed/incomplete/failed event. Output indexes are dense and in
 * emission order, independent of the adapter's block indexes.
 */
async function streamResponsesApi(
  res: ServerResponse,
  stream: AsyncIterable<StreamChunk>,
  model: string,
  signal: AbortSignal,
): Promise<void> {
  const responseId = `resp_${randomUUID()}`
  const createdAt = Math.floor(Date.now() / 1000)
  let headersWritten = false
  let created = false
  let sequence = 0
  const blocks = new Map<number, { id: string; outputIndex: number }>()
  const output: Record<string, unknown>[] = []
  let lastUsage: TokenUsage | undefined
  let finishReason: FinishReason = { kind: 'stop' }

  const sendEvent = async (payload: Record<string, unknown>) => {
    if (!headersWritten) { sseHeaders(res); headersWritten = true }
    const event = { ...payload, sequence_number: sequence++ }
    await writeSse(res, `event: ${String(payload.type)}\ndata: ${JSON.stringify(event)}\n\n`, signal)
  }
  const snapshot = (status: string, extra: Record<string, unknown> = {}) => ({
    id: responseId, object: 'response', created_at: createdAt, status, model,
    output: output.filter(Boolean), error: null, incomplete_details: null, ...extra,
  })

  const ensureCreated = async () => {
    if (created) return
    created = true
    await sendEvent({ type: 'response.created', response: snapshot('in_progress') })
    await sendEvent({ type: 'response.in_progress', response: snapshot('in_progress') })
  }

  const ensureBlock = async (index: number, kind: 'text' | 'reasoning' | 'tool-call', tool?: { id: string; name?: string }) => {
    const existing = blocks.get(index)
    if (existing) return existing
    await ensureCreated()
    const prefix = kind === 'text' ? 'msg_' : kind === 'reasoning' ? 'rs_' : 'fc_'
    const block = { id: prefix + randomUUID(), outputIndex: blocks.size }
    blocks.set(index, block)
    const item = kind === 'text'
      ? { id: block.id, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
      : kind === 'reasoning'
        ? { id: block.id, type: 'reasoning', summary: [] }
        : { id: block.id, type: 'function_call', status: 'in_progress', call_id: tool?.id ?? '', name: tool?.name ?? '', arguments: '' }
    await sendEvent({ type: 'response.output_item.added', output_index: block.outputIndex, item })
    if (kind === 'text') {
      await sendEvent({
        type: 'response.content_part.added', item_id: block.id, output_index: block.outputIndex,
        content_index: 0, part: { type: 'output_text', text: '', annotations: [] },
      })
    } else if (kind === 'reasoning') {
      await sendEvent({
        type: 'response.reasoning_summary_part.added', item_id: block.id, output_index: block.outputIndex,
        summary_index: 0, part: { type: 'summary_text', text: '' },
      })
    }
    return block
  }

  try {
    for await (const chunk of stream) {
      if (chunk.type === 'block-start') {
        // Tool identity arrives with its first delta or completed block.
        if (chunk.blockType === 'text' || chunk.blockType === 'reasoning') await ensureBlock(chunk.index, chunk.blockType)
      } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        const text = chunk.type === 'text-delta'
        const block = await ensureBlock(chunk.index, text ? 'text' : 'reasoning')
        await sendEvent({
          type: text ? 'response.output_text.delta' : 'response.reasoning_summary_text.delta',
          item_id: block.id, output_index: block.outputIndex,
          ...(text ? { content_index: 0 } : { summary_index: 0 }),
          delta: chunk.text,
        })
      } else if (chunk.type === 'tool-call-delta') {
        const block = await ensureBlock(chunk.index, 'tool-call', chunk)
        if (chunk.argumentsDelta) {
          await sendEvent({
            type: 'response.function_call_arguments.delta', item_id: block.id,
            output_index: block.outputIndex, delta: chunk.argumentsDelta,
          })
        }
      } else if (chunk.type === 'block-end') {
        const content = chunk.block
        if (content.type !== 'text' && content.type !== 'reasoning' && content.type !== 'tool-call') continue
        const block = await ensureBlock(chunk.index, content.type, content.type === 'tool-call' ? content : undefined)
        const location = { item_id: block.id, output_index: block.outputIndex }
        let item: Record<string, unknown>
        if (content.type === 'text') {
          const part = { type: 'output_text', text: content.text, annotations: [] }
          await sendEvent({ type: 'response.output_text.done', ...location, content_index: 0, text: content.text })
          await sendEvent({ type: 'response.content_part.done', ...location, content_index: 0, part })
          item = { id: block.id, type: 'message', role: 'assistant', status: 'completed', content: [part] }
        } else if (content.type === 'reasoning') {
          const part = { type: 'summary_text', text: content.text }
          await sendEvent({ type: 'response.reasoning_summary_text.done', ...location, summary_index: 0, text: content.text })
          await sendEvent({ type: 'response.reasoning_summary_part.done', ...location, summary_index: 0, part })
          item = { id: block.id, type: 'reasoning', summary: [part] }
        } else {
          await sendEvent({ type: 'response.function_call_arguments.done', ...location, name: content.name, arguments: content.arguments })
          item = { id: block.id, type: 'function_call', status: 'completed', call_id: content.id, name: content.name, arguments: content.arguments }
        }
        output[block.outputIndex] = item
        await sendEvent({ type: 'response.output_item.done', output_index: block.outputIndex, item })
      } else if (chunk.type === 'usage') {
        lastUsage = chunk.usage
      } else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error') throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code ?? 'SERVER')
        finishReason = chunk.reason
      }
    }
  } catch (error) {
    // A disconnected client cannot receive anything; let the caller clean up.
    if (signal.aborted || res.destroyed) throw error
    await ensureCreated()
    const message = error instanceof Error ? error.message : 'Request failed.'
    const code = error instanceof LlmError ? error.code : 'server_error'
    await sendEvent({ type: 'response.failed', response: snapshot('failed', { error: { code, message } }) })
    res.end()
    return
  }

  await ensureCreated()
  const completion = responsesCompletion(finishReason)
  await sendEvent({
    type: completion.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
    response: snapshot(completion.status, { ...completion, ...responsesUsage(lastUsage) }),
  })
  await writeSse(res, 'data: [DONE]\n\n', signal)
  res.end()
}

export async function startGatewayServer(options: GatewayOptions = {}): Promise<{
  server: Server
  url: string
  connector: FrontierConnector
}> {
  const port = options.port ?? 4317
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Port must be between 0 and 65535.')
  }
  const host = options.host ?? '127.0.0.1'
  const gatewayKey = options.gatewayKey ?? process.env.FRONTIER_GATEWAY_KEY
  assertSafeExposure(host, gatewayKey, options.allowCorsOrigins)
  const maxConcurrent = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrentRequests must be a positive integer.')
  const limiter = { active: 0, max: maxConcurrent }
  const connector = options.connector ?? new FrontierConnector({
    config: options.config,
    claude: options.claude,
    openai: options.openai,
  })

  let boundPort = port
  const server = createServer((req, res) => {
    handleGatewayRequest(req, res, {
      connector,
      boundHost: host,
      boundPort,
      gatewayKey,
      allowCorsOrigins: options.allowCorsOrigins,
      maxBodyBytes: options.maxBodyBytes,
      limiter,
    }).then(handled => {
      if (!handled && !res.headersSent) writeJson(res, 404, openAIErrorPayload(new Error('Not found.'), 404))
    }).catch(error => failSafe(res, error))
  })

  server.requestTimeout = 30_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  boundPort = (server.address() as AddressInfo).port
  return { server, url: `http://${hostAuthority(host, boundPort)}`, connector }
}
