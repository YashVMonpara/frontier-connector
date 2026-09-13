import test from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import { startWebServer } from '../dist/web-server.js'
import { fixture, session } from './helpers.mjs'

async function web(t, overrides = {}) {
  const { store } = await fixture(t)
  await store.save(session())
  const calls = []
  const adapter = {
    listModels: async () => [{ id: 'test-model', name: 'Test model' }],
    resolveModel: async (_, id) => ({ id, name: 'Test model' }),
    usage: async () => ({ five_hour: { utilization: 25 } }),
    async *stream(input) {
      calls.push(input)
      yield { type: 'text-delta', index: 0, text: 'A streamed response' }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }, ...overrides,
  }
  const { server, url } = await startWebServer({ port: 0, config: { authFile: store.path }, adapter })
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const status = await (await fetch(`${url}/api/status`)).json()
  const post = (body, headers = {}) => fetch(`${url}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-frontier-token': status.csrf, ...headers }, body: JSON.stringify(body),
  })
  return { url, calls, status, post }
}

const prompt = { model: 'test-model', messages: [{ role: 'user', text: 'Hello' }] }

test('web status exposes connection and model information but never credential values', async t => {
  const { url, status } = await web(t)
  assert.equal(status.connected, true)
  assert.equal(status.models[0].id, 'test-model')
  assert.ok(!JSON.stringify(status).includes('fake-access-token'))
  assert.ok(!JSON.stringify(status).includes('fake-refresh-token'))
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.match(await page.text(), /Where should we start/)
  assert.equal((await fetch(`${url}/src/auth/store.ts`)).status, 404)
})

test('web chat streams multiple turns through the existing adapter', async t => {
  const { post, calls } = await web(t)
  const response = await post({ ...prompt, messages: [...prompt.messages, { role: 'assistant', text: 'Hi' }, { role: 'user', text: 'Tell me more' }], system: 'Be concise', maxTokens: 2048 })
  const chunks = (await response.text()).trim().split('\n').map(JSON.parse)
  assert.equal(chunks[0].text, 'A streamed response')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(calls[0].messages.map(m => m.role), ['user', 'assistant', 'user'])
  assert.equal(calls[0].system, 'Be concise')
  assert.equal(calls[0].maxTokens, 2048)
})

test('web endpoints reject forged origins and missing session nonces', async t => {
  const { url, post, calls } = await web(t)
  assert.equal((await post(prompt, { origin: 'https://unrelated.example' })).status, 403)
  assert.equal((await post(prompt, { 'x-frontier-token': '' })).status, 403)
  const forgedHost = await new Promise((resolve, reject) => {
    get(`${url}/api/status`, { headers: { host: 'unrelated.example' } }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject)
  })
  assert.equal(forgedHost, 403)
  assert.equal(calls.length, 0)
})

test('web requests reject malformed conversations before provider calls', async t => {
  const { post, calls } = await web(t)
  for (const invalid of [{}, { ...prompt, model: '../bad' }, { ...prompt, maxTokens: 0 }, { ...prompt, messages: [{ role: 'system', text: 'bad' }] }]) {
    assert.equal((await post(invalid)).status, 400)
  }
  assert.equal(calls.length, 0)
})

test('web stream reports provider errors instead of silently returning partial success', async t => {
  const { post } = await web(t, { async *stream() { yield { type: 'text-delta', index: 0, text: 'Partial' }; throw new Error('Provider unavailable') } })
  const chunks = (await (await post(prompt)).text()).trim().split('\n').map(JSON.parse)
  assert.equal(chunks[0].text, 'Partial')
  assert.deepEqual(chunks[1], { type: 'error', message: 'Provider unavailable' })
})

test('disconnecting the web stream cancels the provider request', async t => {
  let cancelled
  const stopped = new Promise(resolve => { cancelled = resolve })
  const { post } = await web(t, { async *stream(input) {
    yield { type: 'text-delta', index: 0, text: 'Start' }
    await new Promise(resolve => input.signal.addEventListener('abort', () => { cancelled(); resolve() }, { once: true }))
  } })
  const response = await post(prompt), reader = response.body.getReader()
  await reader.read(); await reader.cancel()
  await Promise.race([stopped, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Provider was not cancelled')), 1500); timer.unref() })])
})
