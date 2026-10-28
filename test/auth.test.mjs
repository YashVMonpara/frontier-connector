import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TokenManager } from '../dist/auth/manager.js'
import { importClaudeCode } from '../dist/auth/source.js'
import { beginLogin, pkce } from '../dist/auth/oauth.js'
import { createHash } from 'node:crypto'
import { fixture, session } from './helpers.mjs'

test('credential writes are atomic, private and malformed records fail closed', async t => {
  const { store } = await fixture(t)
  assert.equal(await store.read(), undefined)
  await store.save(session())
  assert.equal((await stat(store.path)).mode & 0o777, 0o600)
  assert.equal((await store.read()).accessToken, 'fake-access-token')
  await writeFile(store.path, '{bad json containing fake-secret')
  await assert.rejects(store.read(), error => !error.message.includes('fake-secret'))
  await store.clear()
  assert.equal(await store.read(), undefined)
})

test('concurrent refreshes share the cross-instance token lock', async t => {
  const { store } = await fixture(t)
  await store.save(session({ expiresAt: Date.now() + 1000 }))
  let calls = 0
  const fetchFn = async (url, init) => {
    calls++
    assert.equal(JSON.parse(init.body).grant_type, 'refresh_token')
    return Response.json({ access_token: 'rotated', refresh_token: 'refresh-rotated', expires_in: 3600 })
  }
  const a = new TokenManager(store, fetchFn), b = new TokenManager(store, fetchFn)
  const result = await Promise.all([a.session(), b.session(), a.session()])
  assert.equal(calls, 1)
  assert.ok(result.every(s => s.accessToken === 'rotated'))
})

test('forced refresh uses a concurrently rotated credential without refreshing twice', async t => {
  const { store } = await fixture(t)
  await store.save(session({ accessToken: 'new-token' }))
  const manager = new TokenManager(store, () => { throw new Error('must not fetch') })
  assert.equal((await manager.session('old-rejected-token')).accessToken, 'new-token')
})

test('file import refresh preserves unrelated source fields and syncs token rotation', async t => {
  const { store, dir } = await fixture(t)
  const path = join(dir, 'credentials.json')
  await writeFile(path, JSON.stringify({ extra: { preserve: true }, claudeAiOauth: session({ expiresAt: Date.now() + 100 }) }))
  await store.save(await importClaudeCode(path))
  const manager = new TokenManager(store, async () => Response.json({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 }))
  await manager.session()
  const source = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(source.extra.preserve, true)
  assert.equal(source.claudeAiOauth.accessToken, 'new')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  await store.clear()
  assert.equal(JSON.parse(await readFile(path, 'utf8')).claudeAiOauth.accessToken, 'new')
})

test('PKCE uses an S256 verifier challenge', () => {
  const value = pkce()
  assert.equal(value.challenge, createHash('sha256').update(value.verifier).digest('base64url'))
  assert.notEqual(pkce().verifier, value.verifier)
})

test('OAuth rejects wrong state and exchanges a valid callback exactly once', async () => {
  let calls = 0
  const attempt = await beginLogin({ fetchFn: async (url, init) => {
    calls++
    const body = JSON.parse(init.body)
    assert.equal(body.code, 'test-code')
    assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), authorize.searchParams.get('code_challenge'))
    return Response.json({ access_token: 'new', refresh_token: 'refresh', expires_in: 3600 })
  } })
  const authorize = new URL(attempt.url)
  const callback = new URL(authorize.searchParams.get('redirect_uri'))
  callback.searchParams.set('code', 'test-code')
  callback.searchParams.set('state', 'wrong')
  assert.equal(attempt.submitCallback(callback.href), false)
  callback.searchParams.set('state', authorize.searchParams.get('state'))
  assert.equal(attempt.submitCallback(callback.href), true)
  assert.equal(attempt.submitCallback(callback.href), false)
  assert.equal((await attempt.result).accessToken, 'new')
  assert.equal(calls, 1)
})

test('OAuth listener validates callbacks over HTTP and releases its port', async () => {
  const attempt = await beginLogin({ fetchFn: async () => Response.json({ access_token: 'new', refresh_token: 'refresh', expires_in: 3600 }) })
  const authorize = new URL(attempt.url)
  const callback = new URL(authorize.searchParams.get('redirect_uri'))
  callback.searchParams.set('code', 'test-code')
  callback.searchParams.set('state', authorize.searchParams.get('state'))
  const response = await fetch(callback)
  assert.equal(response.status, 200)
  await response.text()
  await attempt.result
  await assert.rejects(fetch(callback))
})

test('OAuth cancellation and timeout reject and close the callback server', async () => {
  const attempt = await beginLogin()
  attempt.cancel()
  await assert.rejects(attempt.result, /cancelled/)
  const timed = await beginLogin({ timeoutMs: 10 })
  await assert.rejects(timed.result, /timed out/)
})

test('OAuth HTTP errors never echo response secrets', async t => {
  const { store } = await fixture(t)
  await store.save(session({ expiresAt: Date.now() + 100 }))
  const manager = new TokenManager(store, async () => new Response('fake-secret', { status: 400 }))
  await assert.rejects(manager.session(), error => error.message.includes('HTTP 400') && !error.message.includes('fake-secret'))
  assert.equal((await store.read()).accessToken, 'fake-access-token')
})

test('OAuth submitCallback accepts 127.0.0.1 and localhost loopback interchangeably', async () => {
  const attempt = await beginLogin({ fetchFn: async () => Response.json({ access_token: 'new', refresh_token: 'refresh', expires_in: 3600 }) })
  const authorize = new URL(attempt.url)
  const redirectUri = authorize.searchParams.get('redirect_uri')
  const callback = new URL(redirectUri)
  callback.searchParams.set('code', 'test-code')
  callback.searchParams.set('state', authorize.searchParams.get('state'))
  callback.hostname = callback.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
  assert.equal(attempt.submitCallback(callback.href), true)
  assert.equal((await attempt.result).accessToken, 'new')
})
