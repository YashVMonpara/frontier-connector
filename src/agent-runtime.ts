// Stable entry point for embedders; implementation lives under runtime/.
export { HARNESS_VERSION, HarnessAgentRuntime } from './runtime/harness.js'
export type { AgentRunInput, AgentRunResult, AgentRuntime } from './runtime/harness.js'
export { agentActivity } from './runtime/activity.js'
export type { AgentActivityEvent } from './runtime/activity.js'
