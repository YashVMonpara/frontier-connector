import { randomUUID } from 'node:crypto'
import { RequestError } from './chat.js'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  ProviderId,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
  ToolSchema,
} from '../types.js'

export interface ParsedGatewayRequest {
  provider?: ProviderId
  stream: boolean
  includeUsage: boolean
  options: Omit<GenerateOptions, 'provider'>
}

function validateModel(model: unknown): string {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(model)) {
    throw new RequestError('Choose a valid model ID.')
  }
  return model
}

function textFromParts(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(part => {
    if (typeof part === 'string') return part
    if (part && typeof part === 'object') {
      const p = part as Record<string, unknown>
      if ((p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string') {
        return p.text
      }
    }
    return ''
  }).join('')
}

function contentBlocksFromOpenAI(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks: ContentBlock[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const item = part as Record<string, unknown>
    if ((item.type === 'text' || item.type === 'input_text' || item.type === 'output_text') && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text })
    } else if (item.type === 'image_url') {
      const url = typeof item.image_url === 'string'
        ? item.image_url
        : (item.image_url && typeof item.image_url === 'object' ? (item.image_url as Record<string, unknown>).url : undefined)
      if (typeof url === 'string' && url) {
        blocks.push({ type: 'image', url })
      }
    } else if (item.type === 'input_image' && typeof item.image_url === 'string') {
      blocks.push({ type: 'image', url: item.image_url })
    }
  }
  return blocks
}

export function parseOpenAIChatRequest(body: unknown, explicitProvider?: ProviderId): ParsedGatewayRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('Invalid request body.')
  }
  const req = body as Record<string, unknown>
  const model = validateModel(req.model)
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new RequestError('messages must be a non-empty array.')
  }

  const messages: Message[] = []
  for (const raw of req.messages) {
    if (!raw || typeof raw !== 'object') throw new RequestError('Invalid message entry.')
    const msg = raw as Record<string, unknown>
    const role = msg.role
    if (role === 'system' || role === 'developer') {
      const text = textFromParts(msg.content)
      if (text) messages.push({ role: 'system', content: [{ type: 'text', text }] })
    } else if (role === 'user') {
      const blocks = contentBlocksFromOpenAI(msg.content)
      if (!blocks.length) throw new RequestError('User message cannot be empty.')
      messages.push({ role: 'user', content: blocks })
    } else if (role === 'assistant') {
      const blocks = contentBlocksFromOpenAI(msg.content)
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (!call || typeof call !== 'object') continue
          const c = call as Record<string, unknown>
          const fn = (c.function && typeof c.function === 'object' ? c.function : c) as Record<string, unknown>
          if (typeof fn.name === 'string') {
            blocks.push({
              type: 'tool-call',
              id: typeof c.id === 'string' && c.id ? c.id : `call_${randomUUID()}`,
              name: fn.name,
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
            })
          }
        }
      }
      if (blocks.length) messages.push({ role: 'assistant', content: blocks })
    } else if (role === 'tool') {
      const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : ''
      if (!toolCallId) throw new RequestError('Tool message requires tool_call_id.')
      const blocks = contentBlocksFromOpenAI(msg.content)
      messages.push({
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId,
          content: blocks.length ? blocks : [{ type: 'text', text: '' }],
        }],
      })
    } else {
      throw new RequestError(`Unsupported message role: ${String(role)}`)
    }
  }

  let tools: ToolSchema[] | undefined
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    tools = req.tools.map(raw => {
      if (!raw || typeof raw !== 'object') throw new RequestError('Invalid tool definition.')
      const t = raw as Record<string, unknown>
      const fn = (t.type === 'function' && t.function && typeof t.function === 'object' ? t.function : t) as Record<string, unknown>
      if (typeof fn.name !== 'string' || !fn.name) throw new RequestError('Tool must specify a function name.')
      return {
        name: fn.name,
        ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        parameters: (fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} }) as Record<string, unknown>,
      }
    })
  }

  const maxTokensRaw = req.max_completion_tokens ?? req.max_tokens
  const maxTokens = typeof maxTokensRaw === 'number' ? maxTokensRaw : undefined
  const temperature = typeof req.temperature === 'number' ? req.temperature : undefined
  const reasoningEffort = typeof req.reasoning_effort === 'string' && req.reasoning_effort ? req.reasoning_effort : undefined
  const stop = typeof req.stop === 'string' ? [req.stop] : Array.isArray(req.stop) ? req.stop.filter((s): s is string => typeof s === 'string') : undefined
  const streamOptions = req.stream_options && typeof req.stream_options === 'object' ? req.stream_options as Record<string, unknown> : undefined

  return {
    provider: explicitProvider,
    stream: req.stream === true,
    includeUsage: streamOptions?.include_usage === true,
    options: {
      model,
      messages,
      ...(tools ? { tools } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(stop?.length ? { stop } : {}),
    },
  }
}

export function parseAnthropicMessagesRequest(body: unknown, explicitProvider?: ProviderId): ParsedGatewayRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('Invalid request body.')
  }
  const req = body as Record<string, unknown>
  const model = validateModel(req.model)
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new RequestError('messages must be a non-empty array.')
  }

  const system = typeof req.system === 'string'
    ? req.system
    : Array.isArray(req.system)
      ? req.system.map(b => (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text' ? String((b as Record<string, unknown>).text ?? '') : '')).filter(Boolean).join('\n\n')
      : undefined

  const mapBlocks = (content: unknown): ContentBlock[] => {
    if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
    if (!Array.isArray(content)) return []
    const out: ContentBlock[] = []
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue
      const b = raw as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') {
        out.push({ type: 'text', text: b.text })
      } else if (b.type === 'image' && b.source && typeof b.source === 'object') {
        const src = b.source as Record<string, unknown>
        if (src.type === 'base64' && typeof src.media_type === 'string' && typeof src.data === 'string') {
          out.push({ type: 'image', mediaType: src.media_type, dataBase64: src.data })
        } else if (src.type === 'url' && typeof src.url === 'string') {
          out.push({ type: 'image', url: src.url })
        }
      } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        out.push({
          type: 'tool-call',
          id: b.id,
          name: b.name,
          arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
        })
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const resultContent = typeof b.content === 'string'
          ? [{ type: 'text', text: b.content } as ContentBlock]
          : mapBlocks(b.content)
        out.push({
          type: 'tool-result',
          toolCallId: b.tool_use_id,
          content: resultContent.length ? resultContent : [{ type: 'text', text: '' }],
          ...(b.is_error === true ? { isError: true } : {}),
        })
      }
    }
    return out
  }

  const messages: Message[] = []
  for (const raw of req.messages) {
    if (!raw || typeof raw !== 'object') throw new RequestError('Invalid message entry.')
    const m = raw as Record<string, unknown>
    if (m.role !== 'user' && m.role !== 'assistant') {
      throw new RequestError(`Unsupported Anthropic message role: ${String(m.role)}`)
    }
    const content = mapBlocks(m.content)
    if (!content.length) throw new RequestError('Message content cannot be empty.')
    messages.push({ role: m.role, content })
  }

  let tools: ToolSchema[] | undefined
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    tools = req.tools.map(raw => {
      if (!raw || typeof raw !== 'object') throw new RequestError('Invalid tool definition.')
      const t = raw as Record<string, unknown>
      if (typeof t.name !== 'string' || !t.name) throw new RequestError('Tool must specify name.')
      return {
        name: t.name,
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        parameters: (t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} }) as Record<string, unknown>,
      }
    })
  }

  const outputConfig = req.output_config && typeof req.output_config === 'object' ? req.output_config as Record<string, unknown> : undefined
  const reasoningEffort = typeof outputConfig?.effort === 'string' ? outputConfig.effort : undefined
  const maxTokens = typeof req.max_tokens === 'number' ? req.max_tokens : 4096
  const temperature = typeof req.temperature === 'number' ? req.temperature : undefined
  const stop = Array.isArray(req.stop_sequences) ? req.stop_sequences.filter((s): s is string => typeof s === 'string') : undefined

  return {
    provider: explicitProvider,
    stream: req.stream === true,
    includeUsage: true,
    options: {
      model,
      messages,
      ...(system ? { system } : {}),
      ...(tools ? { tools } : {}),
      maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(stop?.length ? { stop } : {}),
    },
  }
}

export function parseResponsesRequest(body: unknown, explicitProvider?: ProviderId): ParsedGatewayRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('Invalid request body.')
  }
  const req = body as Record<string, unknown>
  const model = validateModel(req.model)
  const instructions = typeof req.instructions === 'string' ? req.instructions : undefined

  const messages: Message[] = []
  if (typeof req.input === 'string') {
    if (!req.input.trim()) throw new RequestError('input cannot be empty.')
    messages.push({ role: 'user', content: [{ type: 'text', text: req.input }] })
  } else if (Array.isArray(req.input) && req.input.length > 0) {
    for (const item of req.input) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      if (entry.type === 'function_call' && typeof entry.name === 'string') {
        messages.push({
          role: 'assistant',
          content: [{
            type: 'tool-call',
            id: typeof entry.call_id === 'string' && entry.call_id ? entry.call_id : `call_${randomUUID()}`,
            name: entry.name,
            arguments: typeof entry.arguments === 'string' ? entry.arguments : JSON.stringify(entry.arguments ?? {}),
          }],
        })
      } else if (entry.type === 'function_call_output' && typeof entry.call_id === 'string') {
        const outputText = typeof entry.output === 'string' ? entry.output : JSON.stringify(entry.output ?? '')
        messages.push({
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: entry.call_id, content: [{ type: 'text', text: outputText }] }],
        })
      } else {
        const role = entry.role
        if (role === 'system' || role === 'developer') {
          const text = textFromParts(entry.content)
          if (text) messages.push({ role: 'system', content: [{ type: 'text', text }] })
        } else if (role === 'user' || role === 'assistant') {
          const blocks = contentBlocksFromOpenAI(entry.content)
          if (blocks.length) messages.push({ role, content: blocks })
        }
      }
    }
  } else {
    throw new RequestError('input must be a non-empty string or array.')
  }
  if (!messages.length) throw new RequestError('input produced no valid messages.')

  let tools: ToolSchema[] | undefined
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    tools = req.tools.map(raw => {
      if (!raw || typeof raw !== 'object') throw new RequestError('Invalid tool definition.')
      const t = raw as Record<string, unknown>
      const fn = (t.function && typeof t.function === 'object' ? t.function : t) as Record<string, unknown>
      if (typeof fn.name !== 'string' || !fn.name) throw new RequestError('Tool must specify a function name.')
      return {
        name: fn.name,
        ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        parameters: (fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} }) as Record<string, unknown>,
      }
    })
  }

  const reasoning = req.reasoning && typeof req.reasoning === 'object' ? req.reasoning as Record<string, unknown> : undefined
  const reasoningEffort = typeof reasoning?.effort === 'string' ? reasoning.effort : undefined
  const maxTokens = typeof req.max_output_tokens === 'number' ? req.max_output_tokens : undefined
  const temperature = typeof req.temperature === 'number' ? req.temperature : undefined

  return {
    provider: explicitProvider,
    stream: req.stream === true,
    includeUsage: true,
    options: {
      model,
      messages,
      ...(instructions ? { system: instructions } : {}),
      ...(tools ? { tools } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
  }
}

export function openAIFinishReason(reason: FinishReason): string {
  switch (reason.kind) {
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    default: return 'stop'
  }
}

export function anthropicStopReason(reason: FinishReason): string {
  switch (reason.kind) {
    case 'tool-calls': return 'tool_use'
    case 'max-tokens': return 'max_tokens'
    default: return 'end_turn'
  }
}

export function toOpenAIUsage(usage: TokenUsage) {
  return {
    prompt_tokens: usage.inputTokens + (usage.cacheReadTokens ?? 0),
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } } : {}),
    ...(usage.reasoningTokens !== undefined ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
  }
}

export function toAnthropicUsage(usage: TokenUsage) {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
  }
}

export function openAIErrorPayload(error: unknown) {
  const message = error instanceof Error ? error.message : 'Request failed.'
  return { error: { message, type: 'invalid_request_error', code: null } }
}

export function anthropicErrorPayload(error: unknown) {
  const message = error instanceof Error ? error.message : 'Request failed.'
  return { type: 'error', error: { type: 'invalid_request_error', message } }
}

export async function collectFullResponse(stream: AsyncIterable<StreamChunk>) {
  let text = ''
  let reasoning = ''
  const toolCalls: ToolCallBlock[] = []
  let usage: TokenUsage | undefined
  let finishReason: FinishReason = { kind: 'stop' }
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
    else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCalls.push(chunk.block)
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') {
      finishReason = chunk.reason
      if (chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
    }
  }
  return { text, reasoning, toolCalls, usage, finishReason }
}
