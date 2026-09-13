import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { TokenStore } from '../dist/auth/store.js'

export const session = (overrides = {}) => ({
  accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token',
  expiresAt: Date.now() + 3600_000, scopes: 'user:inference', ...overrides,
})
export async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, store: new TokenStore(join(dir, 'auth.json')) }
}
export const options = (overrides = {}) => ({ provider: 'claude', model: 'test-model',
  messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] })], ...overrides })
export const textEvents = () => [
  { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 8 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello 🌍' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]
export function bytes(text, stride = 7, onCancel) {
  const raw = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset === raw.length) { controller.close(); return }
      controller.enqueue(raw.slice(offset, offset + stride)); offset = Math.min(raw.length, offset + stride)
    }, cancel: onCancel,
  })
}
export const sse = (events = textEvents()) => new Response(bytes(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('')),
  { headers: { 'content-type': 'text/event-stream' } })
export const collect = async iterable => { const values = []; for await (const v of iterable) values.push(v); return values }
