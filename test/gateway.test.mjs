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
