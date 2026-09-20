import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'

export type AgentActivityEvent =
  | { kind: 'step-start'; sessionId: string; turn: number; step: number }
  | { kind: 'tool-call'; sessionId: string; callId: string; name: string; arguments: string }
  | { kind: 'tool-result'; sessionId: string; callId: string; output: string; isError: boolean }
  | { kind: 'retry'; sessionId: string; attempt: number; message: string }
  | { kind: 'subagent-started'; sessionId: string; childSessionId: string }
  | { kind: 'subagent-finished'; sessionId: string; childSessionId: string; status: string }

function limited(value: string, max = 12_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… output truncated by Frontier …`
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.map(block => {
    if (!block || typeof block !== 'object') return ''
    const item = block as Record<string, unknown>
    if ((item.type === 'text' || item.type === 'reasoning') && typeof item.text === 'string') return item.text
    if (item.type === 'tool-result') return contentText(item.content)
    if (item.type === 'image') return '[image]'
    if (item.type === 'file') return '[file]'
    return ''
  }).filter(Boolean).join('\n')
}

/** Reduce the SDK's internal notifications to safe, model-action events for the local UI. */
export function agentActivity(notification: HarnessNotification): AgentActivityEvent | undefined {
  const params = notification.params as Record<string, unknown>
  if (notification.method === 'subagent.started') {
    if (typeof params.parentSessionId === 'string' && typeof params.childSessionId === 'string') {
      return { kind: 'subagent-started', sessionId: params.parentSessionId, childSessionId: params.childSessionId }
    }
    return
  }
  if (notification.method === 'subagent.finished') {
    if (typeof params.parentSessionId === 'string' && typeof params.childSessionId === 'string') {
      return { kind: 'subagent-finished', sessionId: params.parentSessionId, childSessionId: params.childSessionId,
        status: typeof params.status === 'string' ? params.status : 'finished' }
    }
    return
  }
  if (notification.method !== 'session.event' || typeof params.sessionId !== 'string' || !params.event || typeof params.event !== 'object') return
  const event = params.event as { type?: string; data?: Record<string, unknown> }
  const data = event.data ?? {}
  if (event.type === 'step/start' && typeof data.turn === 'number' && typeof data.step === 'number') {
    return { kind: 'step-start', sessionId: params.sessionId, turn: data.turn, step: data.step }
  }
  if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
    return { kind: 'tool-call', sessionId: params.sessionId, callId: data.callId, name: data.name,
      arguments: limited(typeof data.arguments === 'string' ? data.arguments : '') }
  }
  if (event.type === 'tool/result' && data.message && typeof data.message === 'object') {
    const message = data.message as Record<string, unknown>
    const source = message.source && typeof message.source === 'object' ? message.source as Record<string, unknown> : {}
    const result = Array.isArray(message.content)
      ? message.content.find(block => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool-result') as Record<string, unknown> | undefined
      : undefined
    const callId = typeof result?.toolCallId === 'string' ? result.toolCallId : typeof source.callId === 'string' ? source.callId : undefined
    if (callId) return { kind: 'tool-result', sessionId: params.sessionId, callId,
      output: limited(contentText(result?.content)), isError: Boolean(result?.isError || data.error) }
  }
  if (event.type === 'llm/retry') {
    const failure = data.failure && typeof data.failure === 'object' ? data.failure as Record<string, unknown> : {}
    return { kind: 'retry', sessionId: params.sessionId,
      attempt: typeof data.retry === 'number' ? data.retry : 1,
      message: limited(typeof failure.message === 'string' ? failure.message : 'The model request is being retried.', 2_000) }
  }
}
