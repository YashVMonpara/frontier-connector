import { agentActivity } from './activity.js'
import type { AgentActivityEvent } from './activity.js'
import { dirname, join } from 'node:path'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defaultAuthPath } from '../auth/store.js'

export interface AgentRunInput {
  sessionId: string
  provider: 'claude' | 'openai'
  model: string
  prompt: string
  maxTokens?: number
  effort?: string
  signal: AbortSignal
  onActivity?: (event: AgentActivityEvent) => void
}

export interface AgentRunResult {
  text: string
  events: readonly unknown[]
}

export interface AgentRuntime {
  run(input: AgentRunInput): Promise<AgentRunResult>
  disconnect?(provider: AgentRunInput['provider']): Promise<void>
  close(): Promise<void>
  getCwd?(): string
  setCwd?(cwd: string): Promise<void>
}

interface RuntimeEntry {
  harness: DeepSeekHarness
  provider: AgentRunInput['provider']
  route: string
  busy: boolean
  touchedAt: number
}

const runtimePatch = fileURLToPath(new URL('../../frontier-agent.patch.yml', import.meta.url))
export const HARNESS_VERSION = '0.1.5-rc.2'

function ensureSpawnHelper(): void {
  if (process.platform === 'win32') return
  const require = createRequire(import.meta.url)
  const subprocessPackage = require.resolve('@deepseek-ai/dsh-subprocess-local/package.json')
  const fromSubprocess = createRequire(subprocessPackage)
  const nodePtyRoot = dirname(dirname(fromSubprocess.resolve('node-pty')))
  for (const helper of [
    join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
  ]) {
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755)
  }
}

/**
 * Owns complete DeepSeek Harness SDK-profile subprocesses for browser chats.
 * Each conversation gets an isolated agent/session so stopping one response
 * can reap that runtime without interrupting a different conversation.
 */
export class HarnessAgentRuntime implements AgentRuntime {
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly home: string
  private cwd: string

  constructor(options: { home?: string; cwd?: string } = {}) {
    ensureSpawnHelper()
    this.home = options.home ?? join(dirname(defaultAuthPath()), 'harness')
    this.cwd = options.cwd ?? process.cwd()
  }

  getCwd(): string {
    return this.cwd
  }

  async setCwd(newCwd: string): Promise<void> {
    if (this.cwd === newCwd) return
    this.cwd = newCwd
    await this.close()
  }

  private async entry(input: AgentRunInput): Promise<RuntimeEntry> {
    const route = `${input.provider}\0${input.model}\0${input.effort ?? ''}\0${input.maxTokens ?? ''}`
    const current = this.entries.get(input.sessionId)
    if (current?.route === route) return current
    if (current) {
      this.entries.delete(input.sessionId)
      await current.harness.close()
    }
    // Keep the local workspace bounded even if many browser conversations are opened.
    if (this.entries.size >= 4) {
      const oldest = [...this.entries.entries()].filter(([, value]) => !value.busy).sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]
      if (oldest) {
        this.entries.delete(oldest[0])
        await oldest[1].harness.close()
      }
    }
    const harness = new DeepSeekHarness({
      profile: 'sdk', patches: [runtimePatch], dshHome: this.home,
      cwd: this.cwd, processCwd: this.cwd,
      provider: input.provider, model: input.model,
      ...(input.effort ? { reasoningEffort: ReasoningEffortId(input.effort) } : {}),
      ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
      env: {
        ...process.env,
        DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? 'workspace-write',
        // The connector never uploads Harness telemetry from local chats.
        DSH_TELEMETRY_DISABLED: '1',
      },
      initializeTimeoutMs: 60_000,
    })
    const created = { harness, provider: input.provider, route, busy: false, touchedAt: Date.now() }
    this.entries.set(input.sessionId, created)
    return created
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    input.signal.throwIfAborted()
    const entry = await this.entry(input)
    entry.busy = true; entry.touchedAt = Date.now()
    let abort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      abort = () => {
        const error = input.signal.reason instanceof Error ? input.signal.reason : new Error('Response stopped.')
        reject(error)
        this.entries.delete(input.sessionId)
        void entry.harness.close()
      }
      input.signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const result = await Promise.race([
        entry.harness.run(input.prompt, { sessionId: input.sessionId, onNotification: notification => {
          const activity = agentActivity(notification)
          if (activity && input.onActivity) {
            try { input.onActivity(activity) } catch { /* UI observers cannot interrupt the agent loop. */ }
          }
        } }),
        aborted,
      ])
      return { text: result.finalResponse, events: result.events }
    } finally {
      input.signal.removeEventListener('abort', abort)
      entry.busy = false; entry.touchedAt = Date.now()
    }
  }

  async disconnect(provider: AgentRunInput['provider']): Promise<void> {
    const owned = [...this.entries].filter(([, entry]) => entry.provider === provider)
    for (const [sessionId] of owned) this.entries.delete(sessionId)
    await Promise.allSettled(owned.map(([, entry]) => entry.harness.close()))
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(entries.map(entry => entry.harness.close()))
  }
}
