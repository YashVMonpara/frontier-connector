export type Provider = 'claude' | 'openai'
export function providerOf(value: unknown): Provider {
  if (value === undefined) return 'claude'
  if (value !== 'claude' && value !== 'openai') throw new RequestError('Unknown provider.')
  return value
}
export interface ChatInput {
  provider?: Provider
  sessionId?: string
  bootstrap?: boolean
  model: string
  messages: { role: 'user' | 'assistant'; text: string }[]
  system?: string
  maxTokens?: number
  effort?: string
}

export class RequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export function validateChat(value: unknown): ChatInput {
  if (!value || typeof value !== 'object') throw new RequestError('Invalid chat request.')
  const input = value as ChatInput
  providerOf(input.provider)
  if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId))) throw new RequestError('Invalid agent session ID.')
  if (input.bootstrap !== undefined && typeof input.bootstrap !== 'boolean') throw new RequestError('Invalid agent session state.')
  if (typeof input.model !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.model)) throw new RequestError('Choose a valid model ID.')
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 200) throw new RequestError('A conversation must contain between 1 and 200 messages. Start a new chat for a longer conversation.')
  if (input.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 100_000)) throw new RequestError('Messages must contain text, with at most 100,000 characters each.')
  if (input.messages[0].role !== 'user' || input.messages.at(-1)?.role !== 'user') throw new RequestError('The conversation must begin and end with your message.')
  if (input.system !== undefined && (typeof input.system !== 'string' || input.system.length > 20_000)) throw new RequestError('Instructions must be under 20,000 characters.')
  if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 32768)) throw new RequestError('Response length must be between 1 and 32,768 tokens.')
  if (input.effort !== undefined && (typeof input.effort !== 'string' || input.effort.length > 32)) throw new RequestError('Invalid reasoning effort.')
  return input
}

export function agentPrompt(input: ChatInput): string {
  const sections: string[] = []
  if (input.system?.trim()) sections.push(`Conversation instructions:\n${input.system.trim()}`)
  if (input.bootstrap && input.messages.length > 1) {
    const transcript = input.messages.slice(0, -1).map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`).join('\n\n')
    sections.push(`Earlier conversation imported from the local chat interface:\n${transcript}`)
  }
  sections.push(`Current user request:\n${input.messages.at(-1)!.text}`)
  return sections.join('\n\n')
}
