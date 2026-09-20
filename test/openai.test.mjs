import test from 'node:test'
import assert from 'node:assert/strict'
import { openaiGrant, openaiStore, OpenAITokens } from '../dist/auth/openai.js'
import { OpenAIAdapter } from '../dist/openai.js'
import { startWebServer } from '../dist/web-server.js'
import { fixture, session, options, collect, bytes } from './helpers.mjs'

const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
test('OpenAI grant extracts account identity and preserves refresh credentials', async () => {
  let form
  const first = await openaiGrant({ grant_type: 'authorization_code', code: 'test-code' }, async (_, init) => {
    form = new URLSearchParams(init.body)
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } }) })
  })
  assert.equal(form.get('code'), 'test-code')
  assert.equal(first.accountId, 'account')
  const next = await openaiGrant({ grant_type: 'refresh_token' }, async () => Response.json({ access_token: 'next', expires_in: 3600 }), first)
  assert.equal(next.refreshToken, 'refresh')
  assert.equal(next.accountId, 'account')
  await assert.rejects(openaiGrant({}, async () => new Response('secret-value', { status: 400 })), error => !error.message.includes('secret-value'))
})

test('OpenAI concurrent refresh rotates only once', async t => {
  const { store } = await fixture(t), target = openaiStore(`${store.path}.openai`)
  await target.save(session({ accountId: 'account', expiresAt: 1 }))
  let calls = 0
  const tokens = new OpenAITokens(target, async () => { calls++; return Response.json({ access_token: 'rotated', expires_in: 3600 }) })
  const results = await Promise.all([tokens.session(), tokens.session(), tokens.session()])
  assert.equal(calls, 1)
  assert.ok(results.every(value => value.accessToken === 'rotated'))
})

test('OpenAI model discovery authenticates, refreshes after 401, filters and caches', async t => {
  const { store } = await fixture(t), target = openaiStore(`${store.path}.openai`)
  await target.save(session({ accountId: 'account' }))
  let calls = 0
  const adapter = new OpenAIAdapter({ authFile: target.path, fetchFn: async (url, init) => {
    if (url.includes('/oauth/token')) return Response.json({ access_token: 'rotated', expires_in: 3600 })
    calls++
    assert.equal(init.headers['chatgpt-account-id'], 'account')
    if (calls === 1) return new Response('', { status: 401 })
    assert.equal(init.headers.authorization, 'Bearer rotated')
    return Response.json({ models: [{ slug: 'visible' }, { slug: 'hidden', visibility: 'hide' }] })
  } })
  assert.deepEqual((await adapter.listModels('openai')).map(m => m.id), ['visible'])
  await adapter.listModels('openai')
  assert.equal(calls, 2)
})

test('web routes OpenAI separately and logout preserves the other provider', async t => {
  const { store } = await fixture(t), target = openaiStore(`${store.path}.openai`)
  await store.save(session()); await target.save(session({ accountId: 'account' }))
  const adapter = { listModels: async () => [], resolveModel: async (_, id) => ({ id }), usage: async () => ({}), async *stream() { yield { type: 'text-delta', index: 0, text: 'OpenAI response' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const { server, url } = await startWebServer({ port: 0, config: { authFile: store.path }, adapter, openaiAdapter: adapter, agentRuntime: false })
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const status = await (await fetch(`${url}/api/status`)).json()
  const post = (path, body, token = status.csrf) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-frontier-token': token }, body: JSON.stringify(body) })
  assert.equal(status.providers.openai.connected, true)
  assert.match(await (await post('/api/chat', { provider: 'openai', model: 'test', messages: [{ role: 'user', text: 'Hi' }] })).text(), /OpenAI response/)
  assert.equal((await post('/api/auth/logout', { provider: 'openai' }, '')).status, 403)
  assert.equal((await post('/api/auth/logout', { provider: 'openai' })).status, 200)
  assert.equal(await target.read(), undefined)
  assert.ok(await store.read())
  const after = await (await fetch(`${url}/api/status`)).json()
  assert.equal(after.providers.openai.connected, false)
  assert.equal(after.providers.claude.connected, true)
  assert.equal((await post('/api/auth/logout', { provider: 'claude' })).status, 200)
  assert.equal(await store.read(), undefined)
})

for (const contentType of [undefined, 'application/octet-stream', 'text/event-stream; charset=utf-8']) {
  test(`OpenAI validates SSE events with content type ${contentType}`, async t => {
    const { store } = await fixture(t), target = openaiStore(`${store.path}.openai`)
    await target.save(session({ accountId: 'account' }))
    const events = [
      { type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'OK' },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
    const adapter = new OpenAIAdapter({ authFile: target.path, fetchFn: async () => new Response(bytes(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')), { headers: contentType ? { 'content-type': contentType } : {} }) })
    const chunks = await collect(adapter.stream(options({ provider: 'openai' })))
    assert.equal(chunks.find(c => c.type === 'text-delta').text, 'OK')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  })
}

test('OpenAI rejects a non-SSE response even with a successful HTTP status', async t => {
  const { store } = await fixture(t), target = openaiStore(`${store.path}.openai`)
  await target.save(session({ accountId: 'account' }))
  const adapter = new OpenAIAdapter({ authFile: target.path, fetchFn: async () => Response.json({ unexpected: true }) })
  await assert.rejects(collect(adapter.stream(options({ provider: 'openai' }))), /before response.completed/)
})

test('OpenAI sends Harness tools as non-strict Responses functions', async t => {
  const { store } = await fixture(t), target = openaiStore(`${store.path}.openai`)
  await target.save(session({ accountId: 'account' }))
  let body
  const events = [
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'read' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"file_path":"probe.txt"}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'read', arguments: '{"file_path":"probe.txt"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
  ]
  const adapter = new OpenAIAdapter({ authFile: target.path, fetchFn: async (_, init) => {
    body = JSON.parse(init.body)
    return new Response(bytes(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
  } })
  const chunks = await collect(adapter.stream(options({
    provider: 'openai',
    tools: [{ name: 'read', description: 'Read a text file.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
  })))
  assert.equal(body.parallel_tool_calls, true)
  assert.deepEqual(body.tools, [{
    type: 'function', name: 'read', description: 'Read a text file.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }, strict: false,
  }])
  assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.type, 'tool-call')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})
