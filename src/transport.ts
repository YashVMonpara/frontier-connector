import { setTimeout as delay } from 'node:timers/promises'
import { LlmError } from '@deepseek-ai/dsh-llm'

export class HttpError extends LlmError {
  constructor(readonly status: number, readonly retryAfterMs?: number) {
    super(`Claude request failed (HTTP ${status})${retryAfterMs === undefined ? '' : `; retry after ${Math.ceil(retryAfterMs / 1000)} seconds`}.`,
      status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'INVALID_REQUEST')
  }
}

export function retryDelay(headers: Headers, now = Date.now()): number | undefined {
  // Unified headers identify the subscription window that actually refused the request.
  for (const key of ['anthropic-ratelimit-unified-reset', 'anthropic-ratelimit-unified-fallback-reset']) {
    const value = headers.get(key)
    if (!value) continue
    const at = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value)
    if (Number.isFinite(at)) return Math.max(0, at - now)
  }
  const retry = headers.get('retry-after')
  if (retry !== null) {
    const seconds = Number(retry)
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - now
    if (Number.isFinite(ms)) return Math.max(0, ms)
  }
  return undefined
}

export const sleep = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal })

export function idleWatchdog(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  let timer: NodeJS.Timeout
  const touch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new LlmError('Claude stream idle timeout.', 'TIMEOUT')), timeoutMs)
  }
  touch()
  return { signal, touch, close: () => { clearTimeout(timer); controller.abort() } }
}
