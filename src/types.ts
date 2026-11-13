export type ProviderId = 'claude' | 'openai'

export const ToolCallId = (id: string): string => id
export const ReasoningEffortId = (id: string): string => id

export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED'

export type LlmErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'INVALID_REQUEST'
  | 'TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'STREAM_CLOSED'
  | 'UNSUPPORTED'
  | typeof CONTEXT_WINDOW_EXCEEDED_CODE
  | typeof EMPTY_RESPONSE_CODE
  | typeof QUOTA_EXCEEDED_CODE
  | (string & {})

export class LlmError extends Error {
  constructor(message: string, readonly code: LlmErrorCode = 'SERVER') {
    super(message)
    this.name = 'LlmError'
  }
}

export function isContextWindowExceededError(detail: string): boolean {
  return /context[_\s-]*length|context[_\s-]*window|maximum context|too many tokens|prompt is too long|exceeds.*context/i.test(detail)
}

export function isQuotaExceededError(detail: string): boolean {
  return /insufficient[_\s-]*quota|quota[_\s-]*exceeded|billing|usage[_\s-]*limit|credit balance/i.test(detail)
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

export interface ToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
}

export interface ImageAttachmentRef {
  attachmentId: string
  mediaType?: string
  bytes?: number
  width?: number
  height?: number
  name?: string
}

export interface InlineImageBlock {
  type: 'image'
  mediaType: string
  dataBase64: string
}

export interface UrlImageBlock {
  type: 'image'
  url: string
  mediaType?: string
}

export interface AttachmentImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef
}

export type ImageBlock = InlineImageBlock | UrlImageBlock | AttachmentImageBlock

export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: readonly ContentBlock[]
  isError?: boolean
}

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ToolCallBlock
  | ToolResultBlock
  | ImageBlock

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: readonly ContentBlock[]
  source?: unknown
}

export function createUserMessage(input: { content: readonly ContentBlock[]; source?: unknown }): Message {
  return { role: 'user', content: input.content, ...(input.source !== undefined ? { source: input.source } : {}) }
}

export function createAssistantMessage(input: { content: readonly ContentBlock[]; source?: unknown }): Message {
  return { role: 'assistant', content: input.content, ...(input.source !== undefined ? { source: input.source } : {}) }
}

export function createSystemMessage(input: { content: readonly ContentBlock[]; source?: unknown }): Message {
  return { role: 'system', content: input.content, ...(input.source !== undefined ? { source: input.source } : {}) }
}

export interface ToolSchema {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted' }
  | { kind: 'error'; failure: { message: string; code?: string } }

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

export interface GenerateOptions {
  provider: string
  model: string
  messages: readonly Message[]
  system?: string
  tools?: readonly ToolSchema[]
  maxTokens?: number
  reasoningEffort?: string
  temperature?: number
  stop?: readonly string[]
  signal?: AbortSignal
}

export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  inputModalities?: readonly string[]
}

export interface LlmResolvedModelInfo {
  provider: string
  id: string
  name: string
  inputModalities?: readonly string[]
  defaultMaxTokens?: number
  context?: { contextWindow: number }
  reasoning?: { efforts: readonly { id: string; name: string }[] }
}

export interface AttachmentStore {
  readImage(attachment: ImageAttachmentRef, signal?: AbortSignal): Promise<{
    ref: ImageAttachmentRef & { mediaType: string }
    data: Uint8Array
  }>
}

export interface ConnectorAdapter {
  providerInfo(provider: string): { id: string; name: string }
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>
  usage(): Promise<unknown>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
