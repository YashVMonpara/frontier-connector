import test from 'node:test'
import assert from 'node:assert/strict'
import { agentActivity } from '../dist/agent-runtime.js'

test('agent activity exposes tool calls and results without internal session events', () => {
  const call = agentActivity({ method: 'session.event', params: { sessionId: 'root', event: {
    type: 'tool/call', data: { callId: 'call-1', name: 'read', arguments: '{"file_path":"README.md"}' },
  } } })
  const result = agentActivity({ method: 'session.event', params: { sessionId: 'root', event: {
    type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call-1' }, content: [{
      type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }], isError: false,
    }] } },
  } } })
  assert.deepEqual(call, { kind: 'tool-call', sessionId: 'root', callId: 'call-1', name: 'read', arguments: '{"file_path":"README.md"}' })
  assert.deepEqual(result, { kind: 'tool-result', sessionId: 'root', callId: 'call-1', output: 'file contents', isError: false })
  assert.equal(agentActivity({ method: 'session.event', params: { sessionId: 'root', event: {
    type: 'system/message', data: { message: { content: [{ type: 'text', text: 'private prompt' }] } },
  } } }), undefined)
})
