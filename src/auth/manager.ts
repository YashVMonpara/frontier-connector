import { TokenStore } from './store.js'
import type { ClaudeSession } from './store.js'
import { refreshSession } from './oauth.js'
import type { Fetch } from './oauth.js'
import { readSource, syncSource } from './source.js'

export class TokenManager {
  constructor(readonly store = new TokenStore(), private readonly fetchFn: Fetch = fetch) {}

  async session(rejectedAccessToken?: string): Promise<ClaudeSession> {
    return this.store.locked(async () => {
      let current = await this.store.read()
      if (!current) throw new Error('No Claude session. Run frontier auth login or frontier auth import.')
      if (current.source) {
        const source = await readSource(current.source)
        if (source.accessToken !== current.accessToken || source.refreshToken !== current.refreshToken) {
          current = source
          await this.store.write(current)
        }
      }
      const rejected = rejectedAccessToken !== undefined && current.accessToken === rejectedAccessToken
      if (!rejected && current.expiresAt > Date.now() + 5 * 60_000) return current
      if (current.source?.kind === 'keychain') {
        if (!rejected && current.expiresAt > Date.now() + 30_000) return current
        throw new Error('Refresh your imported session by running Claude Code, then retry. Use auth login for independent automatic refresh.')
      }
      const next = await refreshSession(current, this.fetchFn)
      // Persist the rotated token first, even if syncing back to the source fails.
      await this.store.write(next)
      if (current.source) {
        try {
          const synced = await syncSource(current, next)
          await this.store.write(synced)
          return synced
        } catch {
          // Keep the newly issued credential, but detach the source to avoid
          // replacing it with the stale source on the next call.
          const detached = { ...next, source: undefined }
          await this.store.write(detached)
          throw new Error('Token refreshed, but Claude Code credential sync failed. The connector retained the new token; log in to Claude Code again.')
        }
      }
      return next
    })
  }
}
