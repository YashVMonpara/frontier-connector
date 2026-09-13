import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export interface ClaudeSession {
  accountId?: string
  idToken?: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string
  source?: { kind: 'file'; path: string } | { kind: 'keychain' }
}

export function validateSession(value: unknown): ClaudeSession {
  const s = value as ClaudeSession | undefined
  if (!s || typeof s.accessToken !== 'string' || !s.accessToken ||
      typeof s.refreshToken !== 'string' || !s.refreshToken ||
      typeof s.expiresAt !== 'number' || !Number.isFinite(s.expiresAt) || s.expiresAt <= 0 ||
      typeof s.scopes !== 'string' || !s.scopes) {
    throw new Error('Invalid credential record. Log in again; credentials have not been printed.')
  }
  if (s.source && s.source.kind !== 'keychain' &&
      !(s.source.kind === 'file' && typeof s.source.path === 'string' && s.source.path)) {
    throw new Error('Invalid credential source.')
  }
  return s
}

export const defaultAuthPath = () => process.env.FRONTIER_AUTH_FILE ??
  join(homedir(), '.config', 'frontier-connector', 'auth.json')

/** Atomic replacement; secrets never pass through logs or command arguments. */
export async function atomicPrivateWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value) + '\n', 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}

export class TokenStore {
  constructor(readonly path = defaultAuthPath(), readonly provider = 'claude') {}

  async read(): Promise<ClaudeSession | undefined> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Cannot read the connector credential file.')
    }
    try {
      const record = JSON.parse(raw)
      if (record.version !== 1) throw new Error('version')
      return validateSession(record[this.provider])
    } catch { throw new Error('Invalid connector credential file. Run auth login again.') }
  }

  /** Fail closed on abandoned locks: never guess whether another refresh is alive. */
  async locked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const lock = `${this.path}.lock`
    const deadline = Date.now() + 40_000
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() > deadline) throw new Error(`Credential store is locked. If no connector is running, remove ${lock}.`)
        await delay(100)
      }
    }
    try { return await operation() }
    finally { await rm(lock, { recursive: true, force: true }) }
  }

  /** Caller must hold locked() across read/refresh/write transactions. */
  async write(session: ClaudeSession): Promise<void> {
    await atomicPrivateWrite(this.path, { version: 1, [this.provider]: validateSession(session) })
  }

  async save(session: ClaudeSession): Promise<void> { await this.locked(() => this.write(session)) }
  async clear(): Promise<void> { await this.locked(() => rm(this.path, { force: true })) }
}
