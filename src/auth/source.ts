import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { atomicPrivateWrite, validateSession } from './store.js'
import type { ClaudeSession } from './store.js'
import { SCOPE } from './oauth.js'

const exec = promisify(execFile)
type Source = NonNullable<ClaudeSession['source']>
const SERVICE = 'Claude Code-credentials'

async function rawSource(source: Source): Promise<string> {
  if (source.kind === 'file') return readFile(source.path, 'utf8')
  try {
    return (await exec('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w'],
      { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout
  } catch { throw new Error('Cannot read the Claude Code Keychain entry.') }
}

export async function readSource(source: Source): Promise<ClaudeSession> {
  try {
    const blob = JSON.parse(await rawSource(source))
    const value = blob.claudeAiOauth ?? blob
    return validateSession({
      accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt,
      scopes: Array.isArray(value.scopes) ? value.scopes.join(' ') : value.scopes ?? SCOPE,
      source,
    })
  } catch { throw new Error('Cannot read a valid Claude Code session from the selected source.') }
}

export async function importClaudeCode(path?: string): Promise<ClaudeSession> {
  if (path) return readSource({ kind: 'file', path: resolve(path) })
  if (process.platform === 'darwin') {
    try { return await readSource({ kind: 'keychain' }) } catch { /* documented file fallback */ }
  }
  return readSource({ kind: 'file', path: resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json') })
}

/** Compare before replacing so already-rotated source credentials take precedence. */
export async function syncSource(previous: ClaudeSession, next: ClaudeSession): Promise<ClaudeSession> {
  const source = previous.source
  if (!source) return next
  const current = await readSource(source)
  if (current.accessToken !== previous.accessToken || current.refreshToken !== previous.refreshToken) return current
  if (source.kind === 'keychain') {
    // Avoid sending a bearer token in a process argv, where other processes can read it.
    // Imported Keychain sessions are refreshed by Claude Code itself (see manager).
    throw new Error('Keychain sessions must be refreshed by Claude Code. Run claude, then retry; or use auth login.')
  }
  const blob = JSON.parse(await rawSource(source))
  const target = blob.claudeAiOauth ?? blob
  if (target.accessToken !== previous.accessToken || target.refreshToken !== previous.refreshToken) return readSource(source)
  Object.assign(target, { accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt })
  await atomicPrivateWrite(source.path, blob)
  return next
}
