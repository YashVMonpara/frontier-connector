import test from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeAdapter } from '../dist/claude.js'
import { TokenManager } from '../dist/auth/manager.js'
import { retryDelay } from '../dist/transport.js'
import { apply } from '../dist/index.js'
import { fixture, session, sse, options, collect } from './helpers.mjs'

test('subscription transport sets the expected auth, identity and streaming headers', async t => {
  const { store } = await fixture(t)
  await store.save(session())
  const fetchFn = async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages?beta=true')
    assert.equal(init.headers.get('authorization'), 'Bearer fake-access-token')
    assert.equal(init.headers.get('user-agent'), 'claude-cli/2.1.234 (external, cli)')
    assert.equal(init.headers.get('x-app'), 'cli')
    assert.equal(init.redirect, 'error')
    assert.match(JSON.parse(init.body).system[0].text, /Claude Code/)
    return sse()
  }
  const adapter = new ClaudeAdapter({ tokens: new TokenManager(store), fetchFn, cliVersion: '2.1.234' })
  assert.equal((await collect(adapter.stream(options()))).at(-1).reason.kind, 'stop')
})

test('API-key mode neither reads subscription credentials nor sends identity headers', async () => {
  const adapter = new ClaudeAdapter({ authMode: 'api-key', apiKey: 'fake-api-key',
    tokens: { session() { throw new Error('must not read subscription') } },
    fetchFn: async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages')
      assert.equal(init.headers.get('x-api-key'), 'fake-api-key')
      assert.equal(init.headers.get('authorization'), null)
      assert.equal(init.headers.get('x-app'), null)
      assert.deepEqual(JSON.parse(init.body).system, [])
      return sse()
    },
  })
  await collect(adapter.stream(options()))
})

test('a 401 forces exactly one refresh and retries with the new bearer token', async t => {
  const { store } = await fixture(t)
  await store.save(session())
  let refreshes = 0, requests = 0
  const fetchFn = async (url, init) => {
    if (url.includes('/oauth/token')) {
      refreshes++
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
    }
    requests++
    if (requests === 1) return new Response('expired', { status: 401 })
    assert.equal(init.headers.get('authorization'), 'Bearer new-access')
    return sse()
  }
  const adapter = new ClaudeAdapter({ tokens: new TokenManager(store, fetchFn), fetchFn, cliVersion: 'test' })
  await collect(adapter.stream(options()))
  assert.equal(refreshes, 1); assert.equal(requests, 2)
})

test('repeated 401s stop after one refresh', async t => {
  const { store } = await fixture(t)
  await store.save(session())
  let refreshes = 0
  const fetchFn = async url => {
    if (url.includes('/oauth/token')) { refreshes++; return Response.json({ access_token: 'new', refresh_token: 'new-r', expires_in: 3600 }) }
    return new Response('secret must not be echoed', { status: 401 })
  }
  const adapter = new ClaudeAdapter({ tokens: new TokenManager(store, fetchFn), fetchFn, cliVersion: 'test' })
  await assert.rejects(collect(adapter.stream(options())), e => e.status === 401 && !e.message.includes('secret'))
  assert.equal(refreshes, 1)
})

test('rate-limit retries honor the configured budget and request count', async () => {
  let calls = 0
  const adapter = new ClaudeAdapter({ authMode: 'api-key', apiKey: 'fake', fetchFn: async () => {
    calls++
    return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : sse()
  } })
  await collect(adapter.stream(options()))
  assert.equal(calls, 2)
  const limited = new ClaudeAdapter({ authMode: 'api-key', apiKey: 'fake', maxRateLimitWaitMs: 1,
    fetchFn: async () => new Response('', { status: 429, headers: { 'retry-after': '600' } }) })
  await assert.rejects(collect(limited.stream(options())), e => e.status === 429 && e.retryAfterMs === 600_000)
})

test('unified reset headers take precedence over per-bucket rollover snapshots', () => {
  const now = 1_000_000
  assert.equal(retryDelay(new Headers({
    'anthropic-ratelimit-unified-reset': '1010',
    'anthropic-ratelimit-requests-reset': new Date(now + 1).toISOString(),
    'retry-after': '1',
  }), now), 10_000)
  assert.equal(retryDelay(new Headers({ 'anthropic-ratelimit-requests-reset': '1010' }), now), undefined)
})

test('stalling streams time out and cancel the upstream body', async () => {
  let cancelled = false
  const adapter = new ClaudeAdapter({ authMode: 'api-key', apiKey: 'fake', streamIdleTimeoutMs: 15,
    fetchFn: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } }),
  })
  await assert.rejects(collect(adapter.stream(options())), /idle timeout/)
  assert.equal(cancelled, true)
})

test('caller cancellation interrupts an active stream', async () => {
  const controller = new AbortController()
  const adapter = new ClaudeAdapter({ authMode: 'api-key', apiKey: 'fake',
    fetchFn: async () => new Response(new ReadableStream({}), { headers: { 'content-type': 'text/event-stream' } }),
  })
  const result = collect(adapter.stream(options({ signal: controller.signal })))
  setTimeout(() => controller.abort(new Error('user stopped')), 10)
  await assert.rejects(result, /user stopped/)
})

test('partial SSE failures are not replayed as duplicate requests', async () => {
  let calls = 0
  const adapter = new ClaudeAdapter({ authMode: 'api-key', apiKey: 'fake', fetchFn: async () => {
    calls++
    return sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
      { type: 'error', error: { type: 'authentication_error', message: 'expired' } },
    ])
  } })
  await assert.rejects(collect(adapter.stream(options())), /expired/)
  assert.equal(calls, 1)
})

test('model discovery paginates, caches and preserves declared capabilities', async () => {
  let calls = 0
  const adapter = new ClaudeAdapter({ authMode: 'api-key', apiKey: 'fake', discovery: true, fetchFn: async url => {
    calls++
    if (calls === 1) return Response.json({ data: [{ id: 'first', display_name: 'First', capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { supported: true, high: { supported: true } } } }], has_more: true, last_id: 'first' })
    assert.match(url, /after_id=first/)
    return Response.json({ data: [{ id: 'second' }], has_more: false })
  } })
  assert.equal((await adapter.listModels('claude')).length, 2)
  assert.equal((await adapter.listModels('claude')).length, 2)
  assert.equal(calls, 2)
  assert.equal((await adapter.resolveModel('claude', 'first')).reasoning.efforts[0].id, 'high')
})

test('image input fails explicitly without an attachment resolver', async () => {
  let fetched = false
  const adapter = new ClaudeAdapter({ authMode: 'api-key', apiKey: 'fake', fetchFn: async () => { fetched = true; return sse() } })
  const input = options()
  input.messages[0] = { ...input.messages[0], content: [...input.messages[0].content, { type: 'image', attachment: { attachmentId: 'fake' } }] }
  await assert.rejects(collect(adapter.stream(input)), /no attachments service/)
  assert.equal(fetched, false)
})

test('attachment-backed images are resolved into the request', async () => {
  const adapter = new ClaudeAdapter({ authMode: 'api-key', apiKey: 'fake',
    resolveAttachments: () => ({ readImage: async () => ({ ref: { mediaType: 'image/png', attachmentId: 'a', bytes: 3, width: 1, height: 1 }, data: Uint8Array.of(1, 2, 3) }) }),
    fetchFn: async (url, init) => {
      const block = JSON.parse(init.body).messages[0].content.find(b => b.type === 'image')
      assert.equal(block.source.data, 'AQID')
      return sse()
    },
  })
  const input = options()
  input.messages[0] = { ...input.messages[0], content: [...input.messages[0].content, { type: 'image', attachment: { attachmentId: 'a' } }] }
  await collect(adapter.stream(input))
})

test('DSH plugin registers configurable Claude and OpenAI routes with disposal handles', () => {
  const registered = [], cleanups = []
  const ctx = {
    llm: { registerAdapter(routes, adapter) { registered.push([routes, adapter]); return () => cleanups.push(routes[0]) } },
    effect(fn) { cleanups.push(fn()) },
  }
  apply(ctx, { route: 'frontier', openaiRoute: 'openai-frontier' })
  assert.deepEqual(registered.map(([routes]) => routes), [['frontier'], ['openai-frontier']])
  assert.ok(registered[0][1] instanceof ClaudeAdapter)
  for (const cleanup of cleanups.filter(value => typeof value === 'function')) cleanup()
  assert.ok(cleanups.includes('frontier'))
  assert.ok(cleanups.includes('openai-frontier'))
})
