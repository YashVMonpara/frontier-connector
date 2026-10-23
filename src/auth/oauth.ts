import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ClaudeSession } from './store.js'

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const SCOPE = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
export const TOKEN_URL = 'https://claude.ai/v1/oauth/token'
export type Fetch = typeof globalThis.fetch

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function originsEquivalent(actual: URL, expected: URL): boolean {
  if (actual.origin === expected.origin) return true
  return actual.protocol === expected.protocol &&
    actual.port === expected.port &&
    isLoopbackHost(actual.hostname) &&
    isLoopbackHost(expected.hostname)
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function grant(body: Record<string, string>, fetchFn: Fetch, previous?: ClaudeSession): Promise<ClaudeSession> {
  const response = await fetchFn(TOKEN_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
  })
  if (!response.ok) {
    // OAuth response bodies may echo a credential: report only status.
    await response.body?.cancel()
    throw new Error(`Claude OAuth failed (HTTP ${response.status}). Try auth login again.`)
  }
  const data = await response.json() as Record<string, unknown>
  if (typeof data.access_token !== 'string' || !data.access_token ||
      typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw new Error('Claude OAuth returned an invalid token or expiry.')
  }
  const refreshToken = data.refresh_token ?? previous?.refreshToken
  if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('Claude OAuth returned no refresh token.')
  return {
    accessToken: data.access_token, refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: typeof data.scope === 'string' ? data.scope : previous?.scopes ?? SCOPE,
    ...(previous?.source ? { source: previous.source } : {}),
  }
}

export function refreshSession(session: ClaudeSession, fetchFn: Fetch = fetch) {
  return grant({ grant_type: 'refresh_token', refresh_token: session.refreshToken, scope: session.scopes }, fetchFn, session)
}

export interface LoginAttempt {
  url: string
  result: Promise<ClaudeSession>
  submitCallback: (url: string) => boolean
  cancel: () => void
}

export interface OAuthSpec {
  name: string
  authorizeUrl: string
  clientId: string
  scope: string
  callbackPath: string
  ports: number[]
  extra?: Record<string, string>
  exchange: (code: string, verifier: string, redirectUri: string, state: string) => Promise<ClaudeSession>
}

/** Explicit login only; importing this module never opens a browser or reads tokens. */
export async function beginLogin(options: { fetchFn?: Fetch; timeoutMs?: number } = {}): Promise<LoginAttempt> {
  return beginOAuthLogin({ name: 'Claude', authorizeUrl: 'https://claude.ai/oauth/authorize', clientId: CLIENT_ID,
    scope: SCOPE, callbackPath: '/callback', ports: [0], extra: { code: 'true' },
    exchange: (code, verifier, redirectUri, state) => grant({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, state }, options.fetchFn ?? fetch),
  }, options)
}

export async function beginOAuthLogin(spec: OAuthSpec, options: { timeoutMs?: number } = {}): Promise<LoginAttempt> {
  const { verifier, challenge } = pkce()
  const state = randomBytes(32).toString('base64url')
  let resolve!: (session: ClaudeSession) => void
  let reject!: (error: Error) => void
  const result = new Promise<ClaudeSession>((yes, no) => { resolve = yes; reject = no })
  // The UI may attach its await after displaying the URL.
  void result.catch(() => {})
  let settled = false
  let exchanging = false
  let redirectUri = ''
  let timer: NodeJS.Timeout | undefined
  const close = () => { clearTimeout(timer); server.close(); server.closeAllConnections() }
  const fail = (error: Error) => { if (!settled) { settled = true; close(); reject(error) } }
  const submitCallback = (raw: string): boolean => {
    if (settled || exchanging) return false
    let url: URL
    try { url = new URL(raw) } catch { return false }
    const expected = new URL(redirectUri)
    if (!originsEquivalent(url, expected) || url.pathname !== expected.pathname ||
        url.searchParams.get('state') !== state) return false
    if (url.searchParams.has('error')) { fail(new Error(`${spec.name} login was declined.`)); return true }
    const code = url.searchParams.get('code')
    if (!code) return false
    exchanging = true
    void spec.exchange(code, verifier, redirectUri, state)
      .then(session => { if (!settled) { settled = true; close(); resolve(session) } }, fail)
    return true
  }
  const server = createServer((req, res) => {
    const expected = new URL(redirectUri)
    const host = req.headers.host
    const validHost = host === expected.host ||
      (Boolean(host && expected.port) && (
        host === `127.0.0.1:${expected.port}` ||
        host === `localhost:${expected.port}` ||
        host === `[::1]:${expected.port}`
      ))
    if (req.method !== 'GET' || !validHost) {
      res.writeHead(400).end('Invalid callback.'); return
    }
    const accepted = submitCallback(new URL(req.url ?? '/', redirectUri).href)
    res.writeHead(accepted ? 200 : 400, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      .end(accepted ? 'Callback received. Return to the terminal for login status.' : 'Invalid callback or state.')
  })
  let listening = false
  for (const port of spec.ports) {
    try {
      await new Promise<void>((yes, no) => {
        server.once('error', no)
        server.listen(port, 'localhost', () => { server.off('error', no); yes() })
      })
      listening = true; break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  if (!listening) throw new Error(`${spec.name} login ports are busy. Close other login attempts and try again.`)
  redirectUri = `http://localhost:${(server.address() as AddressInfo).port}${spec.callbackPath}`
  server.on('error', () => fail(new Error('OAuth callback server failed.')))
  timer = setTimeout(() => fail(new Error(`${spec.name} login timed out. Connect again to retry.`)), options.timeoutMs ?? 300_000)
  const url = new URL(spec.authorizeUrl)
  url.search = new URLSearchParams({
    ...spec.extra, client_id: spec.clientId, response_type: 'code', redirect_uri: redirectUri,
    scope: spec.scope, code_challenge: challenge, code_challenge_method: 'S256', state,
  }).toString()
  return { url: url.href, result, submitCallback, cancel: () => fail(new Error('Login cancelled.')) }
}
