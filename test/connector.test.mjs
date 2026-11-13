import test from 'node:test'
import assert from 'node:assert/strict'
import { FrontierConnector } from '../dist/connector.js'
import { createUserMessage } from '../dist/types.js'
import { openaiStore } from '../dist/auth/openai.js'
import { fixture, session } from './helpers.mjs'

function mockAdapter(name, modelId) {
  const calls = []
  return {
    calls,
    providerInfo: provider => ({ id: provider, name }),
    listModels: async provider => [{ provider, id: modelId, name: `${name} Model` }],
    resolveModel: async (provider, id) => ({ provider, id, name: `${name} Model` }),
    usage: async () => ({ provider: name }),
    async *stream(opts) {
      calls.push(opts)
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: `Thinking on ${opts.provider}` }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: `Thinking on ${opts.provider}` } }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: `Reply from ${opts.provider}:${opts.model}` }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: `Reply from ${opts.provider}:${opts.model}` } }
      yield { type: 'block-start', index: 2, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'lookup', argumentsDelta: '{"q":"test"}' }
      yield { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"test"}' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  }
}

test('FrontierConnector routes models by prefix, pattern and explicit provider', async t => {
  const { store } = await fixture(t)
  const oaStore = openaiStore(`${store.path}.openai`)
  await store.save(session())
  await oaStore.save(session({ accountId: 'acc-1' }))

  const claude = mockAdapter('Claude', 'claude-sonnet-5')
  const openai = mockAdapter('OpenAI', 'gpt-4o')
  const connector = new FrontierConnector({ config: { authFile: store.path }, claude, openai })

  assert.deepEqual(connector.resolveTarget('claude-sonnet-5'), { provider: 'claude', model: 'claude-sonnet-5' })
  assert.deepEqual(connector.resolveTarget('gpt-4o'), { provider: 'openai', model: 'gpt-4o' })
  assert.deepEqual(connector.resolveTarget('o3-mini'), { provider: 'openai', model: 'o3-mini' })
  assert.deepEqual(connector.resolveTarget('claude/custom-model'), { provider: 'claude', model: 'custom-model' })
  assert.deepEqual(connector.resolveTarget('openai/custom-model'), { provider: 'openai', model: 'custom-model' })
  assert.deepEqual(connector.resolveTarget('chatgpt/gpt-5'), { provider: 'openai', model: 'gpt-5' })
  assert.deepEqual(connector.resolveTarget('custom-id', 'openai'), { provider: 'openai', model: 'custom-id' })

  const models = await connector.listModels()
  assert.deepEqual(models.map(m => `${m.provider}:${m.id}`), ['claude:claude-sonnet-5', 'openai:gpt-4o'])

  const cRes = await connector.generate({
    model: 'claude/claude-sonnet-5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }] })],
  })
  assert.equal(cRes.provider, 'claude')
  assert.equal(cRes.model, 'claude-sonnet-5')
  assert.equal(cRes.text, 'Reply from claude:claude-sonnet-5')
  assert.equal(cRes.reasoning, 'Thinking on claude')
  assert.equal(cRes.toolCalls.length, 1)
  assert.equal(cRes.toolCalls[0].name, 'lookup')

  const oRes = await connector.generate({
    model: 'gpt-4o',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }] })],
  })
  assert.equal(oRes.provider, 'openai')
  assert.equal(oRes.text, 'Reply from openai:gpt-4o')
})

test('FrontierConnector status never leaks credential secrets', async t => {
  const { store } = await fixture(t)
  await store.save(session())
  const connector = new FrontierConnector({ config: { authFile: store.path } })
  const status = await connector.status()
  assert.equal(status.claude.connected, true)
  assert.equal(status.openai.connected, false)
  assert.ok(!JSON.stringify(status).includes('fake-access-token'))
  assert.ok(!JSON.stringify(status).includes('fake-refresh-token'))
})
