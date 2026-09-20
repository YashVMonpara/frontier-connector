import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import { ClaudeAdapter } from './claude.js'
import type { ConnectorOptions } from './claude.js'
import { OpenAIAdapter } from './openai.js'
import type { OpenAIOptions } from './openai.js'

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
export interface Config extends ConnectorOptions {
  route?: string
  openaiRoute?: string
  openai?: OpenAIOptions
}

export function apply(ctx: Context, config: Config = {}): void {
  const route = config.route ?? 'claude'
  const openaiRoute = config.openaiRoute ?? 'openai'
  if (route === openaiRoute) throw new Error('Claude and OpenAI require different DSH routes.')
  const claude = new ClaudeAdapter({ ...config, resolveAttachments: () => ctx.attachments })
  const openai = new OpenAIAdapter({ ...config.openai,
    authFile: config.openai?.authFile ?? (config.authFile ? `${config.authFile}.openai` : undefined) })
  ctx.effect(() => ctx.llm.registerAdapter([route], claude), 'frontier: Claude adapter')
  ctx.effect(() => ctx.llm.registerAdapter([openaiRoute], openai), 'frontier: OpenAI adapter')
}
