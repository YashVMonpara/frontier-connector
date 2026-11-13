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
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024

function isLoopbackAddress(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

function hostAuthority(host: string, port: number): string {
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${hostname}:${port}`
}

function isAllowedHostHeader(hostHeader: string | undefined, boundHost: string, boundPort: number): boolean {
  if (!hostHeader) return false
  try {
    const parsed = new URL(`http://${hostHeader}`)
    const hostname = parsed.hostname
    const port = parsed.port ? Number(parsed.port) : 80
    if (port !== boundPort) return false
    if (isLoopbackAddress(boundHost)) return isLoopbackAddress(hostname)
    return hostname === boundHost
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
  if (error instanceof Error && /Connect .* first|No .* session|Set ANTHROPIC_API_KEY|API-key/i.test(error.message)) {
    return 401
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
  /** Embedded servers can share their connection policy and logout cancellation. */
  isConnected?: (provider: ProviderId) => Promise<boolean>
  streams?: Map<AbortController, ProviderId>
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
    writeJson(res, 400, openAIErrorPayload(new RequestError('Invalid request URL.')))
    return true
  }
  const path = url.pathname
  const isGatewayPath = path === '/health' || path === '/v1/health' || path === '/v1/models' ||
    path.startsWith('/v1/models/') || path === '/v1/chat/completions' || path === '/v1/messages' || path === '/v1/responses'
  if (!isGatewayPath) return false

  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')

  if (!isAllowedHostHeader(req.headers.host, ctx.boundHost, ctx.boundPort)) {
    writeJson(res, 403, openAIErrorPayload(new Error('Invalid Host header.')))
    return true
  }

  const origin = req.headers.origin
  if (origin) {
    const allowed = (ctx.localOrigin && origin === ctx.localOrigin) ||
      (ctx.allowCorsOrigins?.includes(origin) ?? false) ||
      (ctx.allowCorsOrigins?.includes('*') ?? false)
    if (!allowed) {
      writeJson(res, 403, openAIErrorPayload(new Error('Cross-origin browser requests are not allowed.')))
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
        ? anthropicErrorPayload(new Error('Invalid or missing gateway API key.'))
        : openAIErrorPayload(new Error('Invalid or missing gateway API key.'))
      writeJson(res, 401, payload)
      return true
    }
  }

  const isAnthropicEndpoint = path === '/v1/messages'
  const formatError = (error: unknown) => isAnthropicEndpoint ? anthropicErrorPayload(error) : openAIErrorPayload(error)

  try {
    if (req.method === 'GET' && (path === '/health' || path === '/v1/health')) {
      const status = await ctx.connector.status()
      if (ctx.isConnected) {
        for (const provider of ['claude', 'openai'] as const) {
          status[provider].connected = await ctx.isConnected(provider)
        }
      }
      writeJson(res, 200, { ok: true, providers: status })
      return true
    }

    if (req.method === 'GET' && (path === '/v1/models' || path.startsWith('/v1/models/'))) {
      const explicit = explicitProviderHeader(req)
      const models = await ctx.connector.listModels(explicit)
      if (path.startsWith('/v1/models/')) {
        const modelId = decodeURIComponent(path.slice('/v1/models/'.length))
        const match = models.find(m => m.id === modelId || `${m.provider}/${m.id}` === modelId)
        if (!match) {
          writeJson(res, 404, openAIErrorPayload(new Error(`Model '${modelId}' not found.`)))
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
      writeJson(res, 405, formatError(new Error('Method not allowed.')))
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
    const abort = new AbortController()
    const onDisconnect = () => abort.abort(new Error('Client disconnected.'))
    res.once('close', onDisconnect)
    ctx.streams?.set(abort, target.provider)

    try {
      const connected = await (ctx.isConnected ? ctx.isConnected(target.provider) : ctx.connector.isConnected(target.provider))
      if (!connected) {
        throw new RequestError(`Provider '${target.provider}' is not connected. Run frontier auth login --provider ${target.provider}.`, 401)
      }
      abort.signal.throwIfAborted()
      const stream = ctx.connector.stream({ ...parsed.options, provider: target.provider, model: target.model, signal: abort.signal })

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
          ...(result.usage ? {
            usage: {
              input_tokens: result.usage.inputTokens + (result.usage.cacheReadTokens ?? 0),
              output_tokens: result.usage.outputTokens,
              total_tokens: result.usage.inputTokens + (result.usage.cacheReadTokens ?? 0) + result.usage.outputTokens,
            },
          } : {}),
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
      ctx.streams?.delete(abort)
      res.off('close', onDisconnect)
    }
  } catch (error) {
    if (!res.headersSent) {
      writeJson(res, errorStatus(error), formatError(error))
    } else if (!res.destroyed) {
      const payload = isAnthropicEndpoint
        ? `event: error\ndata: ${JSON.stringify(anthropicErrorPayload(error))}\n\n`
        : `data: ${JSON.stringify(openAIErrorPayload(error))}\n\ndata: [DONE]\n\n`
      res.end(payload)
    }
    return true
  }
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
  for await (const chunk of stream) {
    if (chunk.type === 'block-start') {
      await ensureStart()
      if (chunk.blockType === 'text') {
        await sendEvent('content_block_start', { type: 'content_block_start', index: chunk.index, content_block: { type: 'text', text: '' } })
      } else if (chunk.blockType === 'reasoning') {
        await sendEvent('content_block_start', { type: 'content_block_start', index: chunk.index, content_block: { type: 'thinking', thinking: '' } })
      }
      // tool-call starts are deferred until first tool-call-delta so id & name are populated
    } else if (chunk.type === 'text-delta') {
      await ensureStart()
      await sendEvent('content_block_delta', { type: 'content_block_delta', index: chunk.index, delta: { type: 'text_delta', text: chunk.text } })
    } else if (chunk.type === 'reasoning-delta') {
      await ensureStart()
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

async function streamResponsesApi(
  res: ServerResponse,
  stream: AsyncIterable<StreamChunk>,
  model: string,
  signal: AbortSignal,
): Promise<void> {
  const responseId = 'resp_' + randomUUID()
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
    await writeSse(res, 'event: ' + payload.type + '\ndata: ' + JSON.stringify(event) + '\n\n', signal)
  }

  const ensureCreated = async () => {
    if (created) return
    created = true
    const response = { id: responseId, object: 'response', created_at: createdAt, status: 'in_progress', model, output: [], error: null, incomplete_details: null }
    await sendEvent({ type: 'response.created', response })
    await sendEvent({ type: 'response.in_progress', response })
  }

  const ensureBlock = async (
    index: number,
    kind: 'text' | 'reasoning' | 'tool-call',
    tool?: { id: string; name?: string },
  ) => {
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
        : { id: block.id, type: 'function_call', status: 'in_progress', call_id: tool!.id, name: tool!.name ?? '', arguments: '' }
    await sendEvent({ type: 'response.output_item.added', output_index: block.outputIndex, item })
    if (kind === 'text') {
      await sendEvent({
        type: 'response.content_part.added', item_id: block.id, output_index: block.outputIndex,
        content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      })
    } else if (kind === 'reasoning') {
      await sendEvent({
        type: 'response.reasoning_summary_part.added', item_id: block.id, output_index: block.outputIndex,
        summary_index: 0, part: { type: 'summary_text', text: '' },
      })
    }
    return block
  }

  for await (const chunk of stream) {
    if (chunk.type === 'block-start') {
      // Tool identity arrives with its first delta or completed block.
      if (chunk.blockType !== 'tool-call') await ensureBlock(chunk.index, chunk.blockType)
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const text = chunk.type === 'text-delta'
      const block = await ensureBlock(chunk.index, text ? 'text' : 'reasoning')
      await sendEvent({
        type: text ? 'response.output_text.delta' : 'response.reasoning_summary_text.delta',
        item_id: block.id, output_index: block.outputIndex,
        ...(text ? { content_index: 0, logprobs: [] } : { summary_index: 0 }),
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
        const part = { type: 'output_text', text: content.text, annotations: [], logprobs: [] }
        await sendEvent({ type: 'response.output_text.done', ...location, content_index: 0, text: content.text, logprobs: [] })
        await sendEvent({ type: 'response.content_part.done', ...location, content_index: 0, part })
        item = { id: block.id, type: 'message', role: 'assistant', status: 'completed', content: [part] }
      } else if (content.type === 'reasoning') {
        const part = { type: 'summary_text', text: content.text }
        await sendEvent({ type: 'response.reasoning_summary_text.done', ...location, summary_index: 0, text: content.text })
        await sendEvent({ type: 'response.reasoning_summary_part.done', ...location, summary_index: 0, part })
        item = { id: block.id, type: 'reasoning', summary: [part] }
      } else {
        await sendEvent({ type: 'response.function_call_arguments.done', ...location, name: content.name, arguments: content.arguments })
        item = { id: block.id, type: 'function_call', call_id: content.id, name: content.name, arguments: content.arguments, status: 'completed' }
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

  await ensureCreated()
  const completion = responsesCompletion(finishReason)
  await sendEvent({
    type: completion.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
    response: {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      ...completion,
      error: null,
      model,
      output,
      ...(lastUsage ? {
        usage: {
          input_tokens: lastUsage.inputTokens + (lastUsage.cacheReadTokens ?? 0),
          output_tokens: lastUsage.outputTokens,
          total_tokens: lastUsage.inputTokens + (lastUsage.cacheReadTokens ?? 0) + lastUsage.outputTokens,
        },
      } : {}),
    },
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
  const connector = options.connector ?? new FrontierConnector({
    config: options.config,
    claude: options.claude,
    openai: options.openai,
  })

  let boundPort = port
  const server = createServer(async (req, res) => {
    const handled = await handleGatewayRequest(req, res, {
      connector,
      boundHost: host,
      boundPort,
      gatewayKey: options.gatewayKey,
      allowCorsOrigins: options.allowCorsOrigins,
      maxBodyBytes: options.maxBodyBytes,
    })
    if (!handled && !res.headersSent) {
      writeJson(res, 404, openAIErrorPayload(new Error('Not found.')))
    }
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
