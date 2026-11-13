import test from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import OpenAI from 'openai'
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

test('malformed request URLs return 400 before authentication without stopping the gateway', async t => {
  const { url } = await startTestGateway(t, { gatewayOptions: { gatewayKey: 'test-key' } })
  const response = await new Promise((resolve, reject) => {
    get(url, { path: 'http://[' }, res => {
      res.resume()
      resolve(res.statusCode)
    }).on('error', reject)
  })
  assert.equal(response, 400)
  assert.equal((await fetch(url + '/v1/models')).status, 401)
  assert.equal((await fetch(url + '/v1/models', { headers: { 'x-api-key': 'test-key' } })).status, 200)
})

test('gateway accepts ordinary IPv6 loopback requests and still enforces Host and API keys', async t => {
  const { store } = await fixture(t)
  let gateway
  try {
    gateway = await startGatewayServer({ port: 0, host: '::1', gatewayKey: 'ipv6-key', config: { authFile: store.path } })
  } catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) {
      t.skip('IPv6 loopback is unavailable')
      return
    }
    throw error
  }
  const { server, url } = gateway
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  assert.equal((await fetch(url + '/health')).status, 401)
  const response = await fetch(url + '/health', { headers: { 'x-api-key': 'ipv6-key' } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
  const forged = await new Promise((resolve, reject) => {
    get(url + '/health', { headers: { host: 'evil.example', 'x-api-key': 'ipv6-key' } }, res => {
      res.resume()
      resolve(res.statusCode)
    }).on('error', reject)
  })
  assert.equal(forged, 403)
})

test('official Responses SDK accumulates text, reasoning, and tool events', async t => {
  const { url } = await startTestGateway(t)
  const sdk = new OpenAI({ baseURL: url + '/v1', apiKey: 'test-placeholder', maxRetries: 0 })
  const stream = sdk.responses.stream({
    model: 'claude-sonnet-5',
    input: 'Hello',
    tools: [{ type: 'function', name: 'search', parameters: { type: 'object' } }],
  })
  const events = []
  for await (const event of stream) events.push(event)
  const response = await stream.finalResponse()
  assert.equal(response.status, 'completed')
  assert.equal(response.output_text, 'Hello from claude:claude-sonnet-5')
  assert.equal(response.output[0].summary[0].text, 'Step 1')
  assert.equal(response.output[2].call_id, 'call_abc')
  assert.equal(response.output[2].arguments, '{"x":1}')
  for (const type of [
    'response.content_part.added', 'response.content_part.done', 'response.output_text.done',
    'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
    'response.reasoning_summary_text.done', 'response.function_call_arguments.done',
  ]) assert.ok(events.some(event => event.type === type), type)
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, i) => i))
})

test('Responses SDK preserves interleaved sparse blocks and tools with no argument deltas', async t => {
  const { url } = await startTestGateway(t, {
    async *onStream() {
      yield { type: 'reasoning-delta', index: 7, text: 'Reason' }
      yield { type: 'text-delta', index: 3, text: 'Answer' }
      yield { type: 'block-end', index: 3, block: { type: 'text', text: 'Answer' } }
      yield { type: 'block-end', index: 7, block: { type: 'reasoning', text: 'Reason' } }
      yield { type: 'block-end', index: 11, block: { type: 'tool-call', id: 'empty', name: 'ping', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  })
  const sdk = new OpenAI({ baseURL: url + '/v1', apiKey: 'test-placeholder', maxRetries: 0 })
  const response = await sdk.responses.stream({ model: 'claude-test', input: 'Hi' }).finalResponse()
  assert.deepEqual(response.output.map(item => item.type), ['reasoning', 'message', 'function_call'])
  assert.equal(response.output_text, 'Answer')
  assert.equal(response.output[2].arguments, '{}')
  assert.equal(response.output[2].name, 'ping')
})

test('Responses SDK receives incomplete status and details when generation reaches its token limit', async t => {
  const { url } = await startTestGateway(t, {
    async *onStream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Partial' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Partial' } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  })
  const sdk = new OpenAI({ baseURL: url + '/v1', apiKey: 'test-placeholder', maxRetries: 0 })
  const input = { model: 'claude-test', input: 'Hi', max_output_tokens: 1 }
  const json = await sdk.responses.create(input)
  assert.equal(json.status, 'incomplete')
  assert.deepEqual(json.incomplete_details, { reason: 'max_output_tokens' })

  const stream = sdk.responses.stream(input)
  const types = []
  for await (const event of stream) types.push(event.type)
  const response = await stream.finalResponse()
  assert.equal(response.status, 'incomplete')
  assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' })
  assert.ok(types.includes('response.incomplete'))
  assert.ok(!types.includes('response.completed'))
})

test('all gateway protocols enforce none and reject unsupported tool selection before provider calls', async t => {
  const { url, calls } = await startTestGateway(t)
  const protocols = [
    {
      path: '/v1/chat/completions',
      body: { model: 'claude-test', messages: [{ role: 'user', content: 'Hi' }], tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object' } } }] },
      choices: ['none', 'auto', 'required', { type: 'function', function: { name: 'ping' } }, 'invalid'],
    },
    {
      path: '/v1/responses',
      body: { model: 'claude-test', input: 'Hi', tools: [{ type: 'function', name: 'ping', parameters: { type: 'object' } }] },
      choices: ['none', 'auto', 'required', { type: 'function', name: 'ping' }, 'invalid'],
    },
    {
      path: '/v1/messages',
      body: { model: 'claude-test', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }], tools: [{ name: 'ping', input_schema: { type: 'object' } }] },
      choices: [{ type: 'none' }, { type: 'auto' }, { type: 'any' }, { type: 'tool', name: 'ping' }, { type: 'auto', disable_parallel_tool_use: true }],
    },
  ]
  for (const { path, body, choices } of protocols) {
    for (const [i, tool_choice] of choices.entries()) {
      const count = calls.length
      const response = await fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, tool_choice }),
      })
      await response.text()
      assert.equal(response.status, i < 2 ? 200 : 400, path + ' ' + JSON.stringify(tool_choice))
      if (i === 0) assert.equal(calls.at(-1).tools, undefined)
      else if (i === 1) assert.equal(calls.at(-1).tools[0].name, 'ping')
      else assert.equal(calls.length, count, 'unsupported choices must not invoke a provider')
    }
  }
})
