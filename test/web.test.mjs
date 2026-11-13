import test from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import { startWebServer } from '../dist/web-server.js'
import { fixture, session } from './helpers.mjs'

async function web(t, overrides = {}, config = {}) {
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
  const { server, url } = await startWebServer({ port: 0, config: { authFile: store.path, ...config }, adapter })
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const status = await (await fetch(`${url}/api/status`)).json()
  const post = (body, headers = {}) => fetch(`${url}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-frontier-token': status.csrf, ...headers }, body: JSON.stringify(body),
  })
  return { url, calls, status, post }
}

const prompt = { model: 'test-model', messages: [{ role: 'user', text: 'Hello' }] }

test('web status exposes connection, gateway endpoints and model information but never credential values', async t => {
  const { url, status } = await web(t)
  assert.equal(status.connected, true)
  assert.equal(status.models[0].id, 'test-model')
  assert.equal(status.gateway.endpoints.openai, `${url}/v1`)
  assert.equal(status.gateway.endpoints.anthropic, url)
  assert.ok(!JSON.stringify(status).includes('fake-access-token'))
  assert.ok(!JSON.stringify(status).includes('fake-refresh-token'))
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.match(await page.text(), /Where should we start/)
  assert.equal((await fetch(`${url}/src/auth/store.ts`)).status, 404)
  const modelsRes = await fetch(`${url}/v1/models`)
  assert.equal(modelsRes.status, 200)
  const modelsData = await modelsRes.json()
  assert.equal(modelsData.data[0].id, 'test-model')
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

test('web app markdown pattern matches bold and italic words containing n', async () => {
  const { readFile } = await import('node:fs/promises')
  const appJs = await readFile('web/app.js', 'utf8')
  assert.ok(!appJs.includes("[^*\\\\n]+"), 'app.js must not contain double backslash n in character classes')
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g
  assert.ok('**conversation**'.match(pattern), 'bold word with n must match')
  assert.ok('**new**'.match(pattern), 'bold new must match')
  assert.ok('*function*'.match(pattern), 'italic function must match')
})

test('API-key logout cancels gateway inference and disables every gateway protocol', async t => {
  let invoked = 0
  let cancelled
  const stopped = new Promise(resolve => { cancelled = resolve })
  const { url, status, post } = await web(t, {
    async *stream(input) {
      invoked++
      yield { type: 'text-delta', index: 0, text: 'Started' }
      await new Promise(resolve => {
        const stop = () => { cancelled(); resolve() }
        if (input.signal.aborted) stop()
        else input.signal.addEventListener('abort', stop, { once: true })
      })
    },
  }, { authMode: 'api-key', apiKey: 'fake-test-api-key' })
  const call = (path, body) => fetch(url + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const body = { model: 'claude-test', messages: [{ role: 'user', content: 'Hi' }] }
  const active = await call('/v1/chat/completions', { ...body, stream: true })
  const reader = active.body.getReader()
  await reader.read()
  const logout = await fetch(url + '/api/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-frontier-token': status.csrf },
    body: JSON.stringify({ provider: 'claude' }),
  })
  assert.equal(logout.status, 200)
  await logout.text()
  await Promise.race([
    stopped,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Gateway inference was not cancelled')), 1500); timer.unref() }),
  ])
  await reader.cancel()
  assert.equal((await (await fetch(url + '/api/status')).json()).connected, false)
  assert.equal((await (await fetch(url + '/health')).json()).providers.claude.connected, false)
  assert.equal((await post(prompt)).status, 401)
  for (const [path, input] of [
    ['/v1/chat/completions', body],
    ['/v1/messages', { ...body, max_tokens: 10 }],
    ['/v1/responses', { model: 'claude-test', input: 'Hi' }],
  ]) {
    const response = await call(path, input)
    assert.equal(response.status, 401, path)
    await response.text()
  }
  assert.equal(invoked, 1)
})

test('web server answers malformed request URLs with 400 and keeps running', async t => {
  const { url } = await web(t)
  const { hostname, port } = new URL(url)
  const { connect } = await import('node:net')
  const status = await new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => socket.write(`GET //[ HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`))
    let data = ''
    socket.on('data', chunk => { data += chunk }); socket.on('end', () => resolve(Number(data.split(' ')[1]))); socket.on('error', reject)
  })
  assert.equal(status, 400)
  assert.equal((await fetch(`${url}/api/status`)).status, 200)
})
