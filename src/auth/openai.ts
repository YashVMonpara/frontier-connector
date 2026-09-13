import { TokenStore, defaultAuthPath } from './store.js'
import type { ClaudeSession } from './store.js'
import { beginOAuthLogin } from './oauth.js'
import type { Fetch } from './oauth.js'

export const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const SCOPE = 'openid profile email offline_access'
export const openaiStore = (path?: string) => new TokenStore(path ?? `${defaultAuthPath()}.openai`, 'openai')

function claims(token: unknown): Record<string, unknown> {
  if (typeof token !== 'string') return {}
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) } catch { return {} }
}

export async function openaiGrant(body: Record<string, string>, fetchFn: Fetch = fetch, previous?: ClaudeSession): Promise<ClaudeSession> {
  const response = await fetchFn(TOKEN_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: OPENAI_CLIENT_ID, ...body }).toString(),
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenAI sign-in failed (HTTP ${response.status}). Please connect again.`) }
  const data = await response.json() as Record<string, unknown>
  const idToken = typeof data.id_token === 'string' ? data.id_token : previous?.idToken
  const authClaims = (claims(idToken)['https://api.openai.com/auth'] ?? claims(data.access_token)['https://api.openai.com/auth']) as { chatgpt_account_id?: string } | undefined
  const accountId = authClaims?.chatgpt_account_id ?? previous?.accountId
  const refreshToken = data.refresh_token ?? previous?.refreshToken
  const expiresAt = typeof data.expires_in === 'number' && data.expires_in > 0 ? Date.now() + data.expires_in * 1000 : Number(claims(data.access_token).exp) * 1000
  if (typeof data.access_token !== 'string' || !data.access_token || typeof refreshToken !== 'string' || !refreshToken ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now() || typeof accountId !== 'string' || !accountId) throw new Error('OpenAI did not return a usable ChatGPT session.')
  return { accessToken: data.access_token, refreshToken, accountId, idToken, expiresAt, scopes: SCOPE }
}

export function beginOpenAILogin(fetchFn: Fetch = fetch) {
  return beginOAuthLogin({
    name: 'OpenAI', authorizeUrl: 'https://auth.openai.com/oauth/authorize', clientId: OPENAI_CLIENT_ID,
    scope: SCOPE, callbackPath: '/auth/callback', ports: [1455, 1457],
    extra: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs' },
    exchange: (code, verifier, redirectUri) => openaiGrant({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, fetchFn),
  })
}

export class OpenAITokens {
  constructor(readonly store = openaiStore(), private readonly fetchFn: Fetch = fetch) {}
  async session(rejected?: string): Promise<ClaudeSession> {
    return this.store.locked(async () => {
      const current = await this.store.read()
      if (!current?.accountId) throw new Error('Connect OpenAI in settings to continue.')
      if (current.accessToken !== rejected && current.expiresAt > Date.now() + 300_000) return current
      const next = await openaiGrant({ grant_type: 'refresh_token', refresh_token: current.refreshToken }, this.fetchFn, current)
      await this.store.write(next)
      return next
    })
  }
}
