import test from 'node:test'
import assert from 'node:assert/strict'
import { streamAnthropic, toAnthropicMessages, toAnthropicSystem, markMessageCache, CLAUDE_CODE_IDENTITY } from '../dist/translate/anthropic.js'
import { parseSse } from '../dist/translate/sse.js'
import { requestBody } from '../dist/claude.js'
import { bytes, collect, textEvents, sse, options } from './helpers.mjs'

test('SSE framing preserves split UTF-8, CRLF, comments, multiline data and drops truncated tails', async () => {
  const events = await collect(parseSse(bytes(':ping\r\nevent: test\r\ndata: 🌍\r\ndata: next\r\n\r\ndata: incomplete', 1)))
  assert.deepEqual(events, [{ event: 'test', data: '🌍\nnext' }])
})

test('stream emits text, cache usage, output usage and exactly one terminal finish', async () => {
  const chunks = await collect(streamAnthropic(sse().body))
  assert.equal(chunks.find(c => c.type === 'text-delta').text, 'Hello 🌍')
  assert.deepEqual(chunks.find(c => c.type === 'usage').usage, { inputTokens: 12, outputTokens: 3, cacheReadTokens: 8 })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('interleaved reasoning and tool fragments assemble into correlated blocks', async () => {
  const events = [
    { type: 'content_block_start', index: 2, content_block: { type: 'thinking' } },
    { type: 'content_block_start', index: 8, content_block: { type: 'tool_use', id: 'call-1', name: 'weather' } },
    { type: 'content_block_delta', index: 8, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'Check weather' } },
    { type: 'content_block_delta', index: 8, delta: { type: 'input_json_delta', partial_json: '"Berlin"}' } },
    { type: 'content_block_stop', index: 8 }, { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
  ]
  const chunks = await collect(streamAnthropic(sse(events).body))
  const blocks = chunks.filter(c => c.type === 'block-end').map(c => c.block)
  assert.equal(blocks[0].id, 'call-1')
  assert.deepEqual(JSON.parse(blocks[0].arguments), { city: 'Berlin' })
  assert.equal(blocks[1].text, 'Check weather')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('nonempty block starts and zero-argument tools are preserved', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Initial' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call', name: 'ping' } },
    { type: 'content_block_stop', index: 1 }, { type: 'message_stop' },
  ]
  const chunks = await collect(streamAnthropic(sse(events).body))
  assert.equal(chunks.find(c => c.type === 'text-delta').text, 'Initial')
  assert.equal(chunks.filter(c => c.type === 'block-end')[1].block.arguments, '{}')
})

test('truncated, malformed and in-band error streams fail', async () => {
  await assert.rejects(collect(streamAnthropic(sse(textEvents().slice(0, -1)).body)), /before message_stop/)
  await assert.rejects(collect(streamAnthropic(bytes('data: {bad}\n\n'))), /malformed SSE/)
  await assert.rejects(collect(streamAnthropic(sse([{ type: 'error', error: { type: 'rate_limit_error', message: 'limited' } }]).body)), e => e.code === 'RATE_LIMIT')
})

test('early iterator exit cancels upstream consumption', async () => {
  let cancelled = false
  const raw = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n')) },
    cancel() { cancelled = true },
  })
  for await (const chunk of streamAnthropic(raw)) { assert.equal(chunk.type, 'block-start'); break }
  assert.equal(cancelled, true)
})

test('API-key requests do not inherit subscription identity or CLI instructions', () => {
  const body = requestBody(options({ system: 'Be helpful' }), options().messages, { id: 'test-model' }, false)
  assert.equal(body.system[0].text, 'Be helpful')
  assert.ok(!JSON.stringify(body).includes(CLAUDE_CODE_IDENTITY))
  assert.equal(toAnthropicSystem(undefined, [], false).length, 0)
})

test('mid-conversation system messages stay in place and tool results lead merged user messages', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'Opening' }] },
    { role: 'user', content: [{ type: 'text', text: 'Question' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'lookup', arguments: '{}' }] },
    { role: 'system', content: [{ type: 'text', text: 'Reminder' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'Result' }], isError: true }] },
  ]
  const wire = toAnthropicMessages(messages)
  assert.equal(wire.length, 3)
  assert.equal(wire[2].content[0].type, 'tool_result')
  assert.equal(wire[2].content[0].is_error, true)
  assert.equal(wire[2].content[1].text, '<system-reminder>Reminder</system-reminder>')
  const system = toAnthropicSystem(undefined, messages)
  assert.equal(system[0].text, CLAUDE_CODE_IDENTITY)
  assert.equal(system[1].text, 'Opening')
})

test('long histories stay within four prompt-cache breakpoints', () => {
  const wire = toAnthropicMessages(Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: String(i) }] })))
  markMessageCache(wire)
  assert.equal(wire.flatMap(m => m.content).filter(b => b.cache_control).length, 3)
  assert.equal(toAnthropicSystem('System').filter(b => b.cache_control).length, 1)
})

test('thinking effort and token budgets are validated before requests', () => {
  assert.throws(() => requestBody(options({ maxTokens: 0 }), options().messages, { id: 'm' }, true), /positive integer/)
  assert.throws(() => requestBody(options({ reasoningEffort: 'high' }), options().messages, { id: 'm' }, true), /not configured/)
  const model = { id: 'm', efforts: ['high'], thinking: 'adaptive' }
  const body = requestBody(options({ reasoningEffort: 'high' }), options().messages, model, true)
  assert.equal(body.thinking.type, 'adaptive')
  assert.equal(body.output_config.effort, 'high')
})
