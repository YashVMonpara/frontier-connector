import test from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import { startGatewayServer } from '../dist/gateway.js'
import { openaiStore } from '../dist/auth/openai.js'
import { fixture, session } from './helpers.mjs'

async function startTestGateway(t, extra = {}) {
  const { store } = await fixture(t)
  const oaStore = openaiStore(`${store.path}.openai`)
  await store.save(session())
  await oaStore.save(session({ accountId: 'acc-1' }))

  const calls = []
  const makeAdapter = providerName => ({
    providerInfo: p => ({ id: p, name: providerName }),
    listModels: async p => [{ provider: p, id: p === 'claude' ? 'claude-sonnet-5' : 'gpt-4o', name: `${providerName} Default` }],
    resolveModel: async (p, id) => ({ provider: p, id, name: id }),
    usage: async () => ({ ok: true }),
    async *stream(input) {
      calls.push(input)
      if (extra.onStream) {
        yield* extra.onStream(input)
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'Step 1' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Step 1' } }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: `Hello from ${input.provider}:${input.model}` }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: `Hello from ${input.provider}:${input.model}` } }
      if (input.tools?.length) {
        yield { type: 'block-start', index: 2, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 2, id: 'call_abc', name: input.tools[0].name, argumentsDelta: '{"x":1}' }
        yield { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_abc', name: input.tools[0].name, arguments: '{"x":1}' } }
        yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 8, cacheReadTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  const { server, url } = await startGatewayServer({
    port: 0,
    config: { authFile: store.path },
    claude: makeAdapter('Claude'),
    openai: makeAdapter('OpenAI'),
    ...extra.gatewayOptions,
  })
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  return { url, calls, store, oaStore }
}

test('gateway exposes /health, /v1/models and /v1/models/:id across connected providers', async t => {
  const { url } = await startTestGateway(t)
  const health = await (await fetch(`${url}/health`)).json()
  assert.equal(health.ok, true)
  assert.equal(health.providers.claude.connected, true)
  assert.equal(health.providers.openai.connected, true)
  assert.ok(!JSON.stringify(health).includes('fake-access-token'))

  const models = await (await fetch(`${url}/v1/models`)).json()
  assert.equal(models.object, 'list')
  assert.deepEqual(models.data.map(m => m.id), ['claude-sonnet-5', 'gpt-4o'])

  const single = await fetch(`${url}/v1/models/gpt-4o`)
  assert.equal(single.status, 200)
  assert.equal((await single.json()).owned_by, 'openai')
  assert.equal((await fetch(`${url}/v1/models/nonexistent`)).status, 404)
})

test('gateway /v1/chat/completions handles non-streaming and streaming OpenAI format for both Claude and OpenAI', async t => {
  const { url, calls } = await startTestGateway(t)

  // Non-streaming JSON to Claude
  const res1 = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      messages: [
        { role: 'system', content: 'Be terse' },
        { role: 'user', content: [{ type: 'text', text: 'Look at this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }] },
      ],
      tools: [{ type: 'function', function: { name: 'search', description: 'Search docs', parameters: { type: 'object' } } }],
    }),
  })
  assert.equal(res1.status, 200)
  const json = await res1.json()
  assert.equal(json.object, 'chat.completion')
  assert.equal(json.choices[0].message.content, 'Hello from claude:claude-sonnet-5')
  assert.equal(json.choices[0].message.reasoning_content, 'Step 1')
  assert.equal(json.choices[0].message.tool_calls[0].function.name, 'search')
  assert.equal(json.choices[0].finish_reason, 'tool_calls')
  assert.equal(json.usage.prompt_tokens, 18)
  assert.equal(calls[0].messages[1].content[1].type, 'image')

  // Streaming SSE to OpenAI
  const res2 = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-4o',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Hello OpenAI' }],
    }),
  })
  assert.equal(res2.status, 200)
  assert.match(res2.headers.get('content-type'), /text\/event-stream/)
  const raw = await res2.text()
  const events = raw.split('\n\n').filter(Boolean).map(block => block.replace(/^data: /, ''))
  assert.equal(events.at(-1), '[DONE]')
  const parsed = events.slice(0, -1).map(JSON.parse)
  assert.ok(parsed.some(c => c.choices?.[0]?.delta?.content === 'Hello from openai:gpt-4o'))
  assert.ok(parsed.some(c => c.choices?.[0]?.finish_reason === 'stop'))
  assert.equal(parsed.at(-1).usage.completion_tokens, 6)
})

test('gateway /v1/messages speaks Anthropic Messages API (streaming and non-streaming)', async t => {
  const { url } = await startTestGateway(t)

  const resJson = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      system: 'System rule',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi Claude' }],
    }),
  })
  assert.equal(resJson.status, 200)
  const msg = await resJson.json()
  assert.equal(msg.type, 'message')
  assert.equal(msg.stop_reason, 'end_turn')
  assert.equal(msg.content.find(b => b.type === 'text').text, 'Hello from claude:claude-sonnet-5')

  const resSse = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      stream: true,
      messages: [{ role: 'user', content: 'Stream please' }],
      tools: [{ name: 'ping', input_schema: { type: 'object' } }],
    }),
  })
  assert.equal(resSse.status, 200)
  const sseText = await resSse.text()
  assert.match(sseText, /event: message_start/)
  assert.match(sseText, /event: content_block_start/)
  assert.match(sseText, /event: content_block_delta/)
  assert.match(sseText, /event: message_delta/)
  assert.match(sseText, /"stop_reason":"tool_use"/)
  assert.match(sseText, /event: message_stop/)
})

test('gateway /v1/responses speaks OpenAI Responses API (streaming and non-streaming)', async t => {
  const { url } = await startTestGateway(t)

  const resJson = await fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', input: 'Hello Responses' }),
  })
  assert.equal(resJson.status, 200)
  const data = await resJson.json()
  assert.equal(data.object, 'response')
  assert.equal(data.output_text, 'Hello from openai:gpt-4o')

  const resStream = await fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', stream: true, input: 'Stream Responses' }),
  })
  assert.equal(resStream.status, 200)
  const text = await resStream.text()
  assert.match(text, /"type":"response\.created"/)
  assert.match(text, /"type":"response\.output_text\.delta"/)
  assert.match(text, /"type":"response\.completed"/)
  assert.match(text, /data: \[DONE\]/)
})

test('gateway enforces gatewayKey, rejects forged Host and unauthorized browser Origins', async t => {
  const { url } = await startTestGateway(t, {
    gatewayOptions: { gatewayKey: 'secret-local-key' },
  })

  // Missing or invalid key -> 401
  assert.equal((await fetch(`${url}/v1/models`)).status, 401)
  assert.equal((await fetch(`${url}/v1/models`, { headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await fetch(`${url}/v1/models`, { headers: { authorization: 'Bearer secret-local-key' } })).status, 200)
  assert.equal((await fetch(`${url}/v1/models`, { headers: { 'x-api-key': 'secret-local-key' } })).status, 200)

  // Forged Origin -> 403
  assert.equal((await fetch(`${url}/v1/models`, {
    headers: { authorization: 'Bearer secret-local-key', origin: 'https://evil.example' },
  })).status, 403)

  // Forged Host -> 403
  const forgedHost = await new Promise((resolve, reject) => {
    get(`${url}/v1/models`, { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject)
  })
  assert.equal(forgedHost, 403)
})

test('gateway rejects requests when provider is not logged in and aborts upstream on disconnect', async t => {
  let cancelled
  const stopped = new Promise(resolve => { cancelled = resolve })
  const { url, oaStore } = await startTestGateway(t, {
    async *onStream(input) {
      yield { type: 'text-delta', index: 0, text: 'Start' }
      await new Promise(resolve => input.signal.addEventListener('abort', () => { cancelled(); resolve() }, { once: true }))
    },
  })

  await oaStore.clear()
  const unauth = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
  })
  assert.equal(unauth.status, 401)

  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', stream: true, messages: [{ role: 'user', content: 'Hi' }] }),
  })
  const reader = res.body.getReader()
  await reader.read()
  await reader.cancel()
  await Promise.race([
    stopped,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream was not aborted')), 1500); timer.unref() }),
  ])
})

// --- Regression tests for the gateway security review ---

import { connect } from 'node:net'

function rawRequest(url, requestLine, headers = '') {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`${requestLine}\r\nHost: ${hostname}:${port}\r\n${headers}Connection: close\r\n\r\n`)
    })
    let data = ''
    socket.on('data', chunk => { data += chunk })
    socket.on('end', () => resolve(Number(data.split(' ')[1])))
    socket.on('error', reject)
  })
}

const sseEvents = text => text.split('\n\n').filter(Boolean)
  .map(block => block.split('\n').find(line => line.startsWith('data: '))?.slice(6))
  .filter(data => data && data !== '[DONE]').map(data => JSON.parse(data))

test('malformed request URLs and model escapes return 400 without crashing the gateway', async t => {
  const { url } = await startTestGateway(t)
  assert.equal(await rawRequest(url, 'GET //[ HTTP/1.1'), 400)
  assert.equal((await fetch(`${url}/v1/models/%E0`)).status, 400)
  assert.equal((await fetch(`${url}/health`)).status, 200, 'gateway must still be serving')
})

test('gateway refuses non-loopback binds and wildcard CORS without a gateway key', async () => {
  const saved = process.env.FRONTIER_GATEWAY_KEY
  delete process.env.FRONTIER_GATEWAY_KEY
  try {
    await assert.rejects(startGatewayServer({ port: 0, host: '0.0.0.0' }), /without a gateway key/)
    await assert.rejects(startGatewayServer({ port: 0, allowCorsOrigins: ['*'] }), /without a gateway key/)
  } finally {
    if (saved !== undefined) process.env.FRONTIER_GATEWAY_KEY = saved
  }
})

test('wildcard binds require the gateway key even with a forged Host header', async t => {
  const { server } = await startGatewayServer({ port: 0, host: '0.0.0.0', gatewayKey: 'lan-key' })
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const port = server.address().port
  const status = headers => new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port, path: '/v1/models', headers: { host: `0.0.0.0:${port}`, ...headers } }, res => {
      res.resume(); resolve(res.statusCode)
    }).on('error', reject)
  })
  assert.equal(await status({}), 401)
  assert.equal(await status({ authorization: 'Bearer lan-key' }), 200)
})

test('a provider-prefixed model is routed once and never re-parsed into another provider', async t => {
  const { url, calls } = await startTestGateway(t)
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'openai/claude/x', messages: [{ role: 'user', content: 'Hi' }] }),
  })
  assert.equal(res.status, 200)
  assert.equal(calls[0].provider, 'openai')
  assert.equal(calls[0].model, 'claude/x')
})

test('out-of-range sampling parameters are rejected before any provider call', async t => {
  const { url, calls } = await startTestGateway(t)
  const send = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const chat = { model: 'claude-x', messages: [{ role: 'user', content: 'Hi' }] }
  for (const extra of [{ max_tokens: -1 }, { max_tokens: 1.5 }, { max_tokens: 10_000_000 }, { temperature: 5 }, { temperature: 'hot' }]) {
    const res = await send('/v1/chat/completions', { ...chat, ...extra })
    assert.equal(res.status, 400, JSON.stringify(extra))
    assert.equal((await res.json()).error.type, 'invalid_request_error')
  }
  assert.equal((await send('/v1/messages', { ...chat, max_tokens: 0 })).status, 400)
  assert.equal((await send('/v1/responses', { model: 'claude-x', input: 'Hi', max_output_tokens: -5 })).status, 400)
  assert.equal(calls.length, 0)
})

test('gateway caps concurrent inference requests with 429 and frees the slot afterwards', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { url } = await startTestGateway(t, {
    gatewayOptions: { maxConcurrentRequests: 1 },
    async *onStream() {
      yield { type: 'text-delta', index: 0, text: 'busy' }
      await gate
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const send = () => fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-x', stream: true, messages: [{ role: 'user', content: 'Hi' }] }),
  })
  const first = await send()
  const reader = first.body.getReader()
  await reader.read()
  const second = await send()
  assert.equal(second.status, 429)
  assert.equal((await second.json()).error.type, 'rate_limit_error')
  release()
  while (!(await reader.read()).done) { /* drain */ }
  const third = await send()
  assert.equal(third.status, 200)
  await third.text()
})

test('error payloads carry a type matching the HTTP status', async t => {
  const { url, oaStore } = await startTestGateway(t, { gatewayOptions: { gatewayKey: 'k' } })
  const noKey = await fetch(`${url}/v1/messages`, { method: 'POST' })
  assert.equal(noKey.status, 401)
  assert.equal((await noKey.json()).error.type, 'authentication_error')
  await oaStore.clear()
  const disconnected = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
  })
  assert.equal(disconnected.status, 401)
  assert.equal((await disconnected.json()).error.type, 'authentication_error')
})

test('typed adapter auth errors map to 401 without message matching', async t => {
  const { LlmError } = await import('../dist/types.js')
  const { url } = await startTestGateway(t, {
    async *onStream() { throw new LlmError('Session revoked upstream.', 'AUTH') },
  })
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'Hi' }] }),
  })
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error.type, 'authentication_error')
})

test('Responses stream follows the spec event sequence with dense output indexes', async t => {
  const { url } = await startTestGateway(t)
  const res = await fetch(`${url}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-x', stream: true, input: 'Hi', tools: [{ type: 'function', name: 'search', parameters: { type: 'object' } }] }),
  })
  const events = sseEvents(await res.text())
  assert.deepEqual(events.map(e => e.type), [
    'response.created', 'response.in_progress',
    'response.output_item.added', 'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done',
    'response.output_item.added', 'response.content_part.added', 'response.output_text.delta',
    'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
    'response.output_item.added', 'response.function_call_arguments.delta',
    'response.function_call_arguments.done', 'response.output_item.done',
    'response.completed',
  ])
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i))
  assert.deepEqual(events.filter(e => e.type === 'response.output_item.added').map(e => e.output_index), [0, 1, 2])
  const done = events.at(-1).response
  assert.deepEqual(done.output.map(item => item.type), ['reasoning', 'message', 'function_call'])
  assert.equal(done.usage.input_tokens, 18)
})

test('a mid-stream provider failure ends a Responses stream with response.failed', async t => {
  const { url } = await startTestGateway(t, {
    async *onStream() {
      yield { type: 'text-delta', index: 0, text: 'Partial' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Upstream overloaded', code: 'SERVER' } } }
    },
  })
  const res = await fetch(`${url}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-x', stream: true, input: 'Hi' }),
  })
  const events = sseEvents(await res.text())
  const last = events.at(-1)
  assert.equal(last.type, 'response.failed')
  assert.equal(last.response.status, 'failed')
  assert.equal(last.response.error.message, 'Upstream overloaded')
})

test('Anthropic stream opens a content block before deltas even without block-start', async t => {
  const { url } = await startTestGateway(t, {
    async *onStream() {
      yield { type: 'text-delta', index: 0, text: 'Hi' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Hi' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-x', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] }),
  })
  const types = sseEvents(await res.text()).map(e => e.type)
  assert.deepEqual(types, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
})
