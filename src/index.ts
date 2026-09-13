import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import { ClaudeAdapter } from './claude.js'
import type { ConnectorOptions } from './claude.js'

export { ClaudeAdapter, DEFAULT_MODELS } from './claude.js'
export { OpenAIAdapter } from './openai.js'
export { beginOpenAILogin } from './auth/openai.js'
export type { ConnectorOptions, Model } from './claude.js'
export { TokenStore } from './auth/store.js'
export { TokenManager } from './auth/manager.js'
export { beginLogin } from './auth/oauth.js'
export { importClaudeCode } from './auth/source.js'

export const name = 'dsh-plugin-frontier-connector'
export const inject = ['llm']
export interface Config extends ConnectorOptions { route?: string }

export function apply(ctx: Context, config: Config = {}): void {
  const route = config.route ?? 'claude'
  const adapter = new ClaudeAdapter({ ...config, resolveAttachments: () => ctx.attachments })
  ctx.effect(() => ctx.llm.registerAdapter([route], adapter), 'frontier: Claude adapter')
}
