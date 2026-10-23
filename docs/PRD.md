# Product Requirements Document (PRD)
## Frontier Connector v0.2.0: Multimodal Resilience, OpenAI Parity, and Workspace Control

**Document Status:** Approved for Implementation  
**Target Release:** `v0.2.0`  
**Target Date:** Q4 2026  
**Authors:** Yash Monpara & Antigravity  

---

### 1. Executive Summary

`frontier-connector` is an open-source DeepSeek Harness (DSH) workspace bridge that routes Claude and OpenAI subscription models from local workstations. It enables developers to leverage their existing personal AI subscriptions within an agentic harness capable of local shell execution, file editing, skill acquisition, and multi-turn workflows without incurring per-token API charges.

While the `v0.1.0` release proved the core loopback integration concept, real-world utility has been constrained by several architectural and feature gaps:
1. **OpenAI Incompleteness**: Absence of multimodal attachment resolution and reasoning replay for OpenAI models, alongside complete absence of OpenAI CLI commands.
2. **Brittle Authentication Flow**: Callback URL mismatch between `localhost` and `127.0.0.1` causing sign-in failures.
3. **Rigid Workspace Binding**: Hardcoded working directory defaulting to the connector's own repo, hindering agent use on arbitrary projects.
4. **Data Portability Gaps**: Inability to export or import conversation sessions.

This PRD specifies the functional, architectural, and security requirements to resolve these critical issues, achieve provider parity, and make Frontier a dependable daily driver for developers.

---

### 2. Goals & Success Metrics

#### Primary Goals
1. **Full Provider Feature Parity**: Match Claude capabilities in OpenAI (attachments, reasoning replay, CLI management).
2. **Seamless Authentication UX**: Eliminate OAuth callback failures across loopback interfaces (`localhost` vs `127.0.0.1`).
3. **Flexible Workspace Control**: Enable users to dynamically configure the agent's target working directory (`cwd`) from both the Web UI and CLI.
4. **Chat Portability**: Provide one-click conversation export (JSON and Markdown) and JSON import.
5. **Zero Test Regressions**: Expand automated test suite coverage to validate all new paths without breaking existing tests.

#### Success Metrics
- **100% Passing Tests**: All existing 49 tests + new unit & integration tests pass cleanly in Node 22/24.
- **Zero Callback Failures**: Users can authenticate regardless of whether their browser resolves to `localhost` or `127.0.0.1`.
- **Zero Image Drops**: Attachment-backed images resolve properly for both Claude and OpenAI requests.

---

### 3. User Personas

| Persona | Needs | Pain Points in v0.1.0 |
|---|---|---|
| **Full-Stack Developer** | Run an autonomous agent over their local repo to fix bugs or generate code. | Agent was locked to `frontier-connector`'s folder; had to launch from target folder without UI choice. |
| **CLI Enthusiast** | Quick prompts and scripts in terminal using Claude or OpenAI. | CLI only had Claude commands; OpenAI was inaccessible from terminal. |
| **Multi-Model Evaluator** | Compare reasoning and vision performance across Claude and OpenAI on same prompts. | OpenAI dropped image attachments; reasoning chains in OpenAI models broke on tool calls. |

---

### 4. Detailed Feature Requirements

#### Feature 1: OpenAI Multimodal Attachment & Image Resolution
- **Requirement 1.1**: `OpenAIOptions` interface must accept `resolveAttachments?: () => AttachmentStore | undefined`.
- **Requirement 1.2**: In `OpenAIAdapter.stream()`, `resolveImages` must be called on `options.messages` before translating into Responses input format.
- **Requirement 1.3**: In `src/index.ts`, `apply(ctx)` must wire `resolveAttachments: () => ctx.attachments` into `OpenAIAdapter` instantiation.
- **Requirement 1.4**: If images are supplied without an attachment resolver, fail gracefully with an explicit error rather than silently omitting them.

#### Feature 2: OpenAI Reasoning Replay State Machine
- **Requirement 2.1**: Update `ResponsesStreamTranslator` in `src/translate/responses.ts` to capture completed reasoning output items (`item.type === 'reasoning'` with `encrypted_content`).
- **Requirement 2.2**: Correlate captured reasoning items with the subsequent `function_call` item(s) in that response.
- **Requirement 2.3**: In `OpenAIAdapter`, maintain a session/adapter-level cache of reasoning items by tool call ID and supply `reasoningFor` to `toResponsesInput()`.
- **Requirement 2.4**: Verify that when a tool result is sent back, the encrypted reasoning payload is replayed ahead of the function call item on the next turn.

#### Feature 3: Resilient Loopback OAuth Callback Handling
- **Requirement 3.1**: In `src/auth/oauth.ts`, `submitCallback()` must treat `localhost` and `127.0.0.1` as equivalent hostnames.
- **Requirement 3.2**: When checking callback validity, verify matching protocol, port, pathname, and state token, while allowing hostname equivalence (`localhost` <-> `127.0.0.1`).
- **Requirement 3.3**: Ensure both browser-driven redirects and manual pastes in the Web UI work seamlessly regardless of IP vs hostname representation.

#### Feature 4: Full OpenAI CLI Support & Provider Parameter
- **Requirement 4.1**: Add `--provider <claude|openai>` parameter to `src/cli.ts` (defaulting to `claude` for backward compatibility).
- **Requirement 4.2**: Implement OpenAI support for CLI commands:
  - `frontier auth login --provider openai`: Initiates OpenAI OAuth PKCE login.
  - `frontier auth logout --provider openai`: Clears OpenAI credentials.
  - `frontier auth status --provider openai`: Displays OpenAI authentication status and token expiry.
  - `frontier models --provider openai`: Discovers and lists models from OpenAI account.
  - `frontier usage --provider openai`: Queries `/backend-api/wham/usage` limits.
  - `frontier chat "prompt" --provider openai`: Streams response from OpenAI via CLI.
- **Requirement 4.3**: Add `--cwd <path>` parameter to CLI `web` and `chat` commands to designate working directory.

#### Feature 5: Configurable Workspace Directory in Runtime & Web UI
- **Requirement 5.1**: `HarnessAgentRuntime` must support setting and switching the active workspace directory `cwd` dynamically.
- **Requirement 5.2**: Add `GET /api/workspace` and `POST /api/workspace` endpoints in `src/web-server.ts` to retrieve and change the active workspace path, validating that the target directory exists and is accessible.
- **Requirement 5.3**: In `web/index.html` and `web/app.js`:
  - Display the active workspace folder path in the header/topbar.
  - Provide a settings control allowing users to update the workspace directory.
  - Reset agent session when workspace changes to guarantee directory isolation.

#### Feature 6: Conversation Export & Import
- **Requirement 6.1**: Add "Export Conversation" button in the conversation menu/actions:
  - Export as Markdown (`.md` formatted with system instructions, user prompts, assistant replies, and tool activity summaries).
  - Export as JSON (`.json` compatible with Frontier workspace schema).
- **Requirement 6.2**: Add "Import Conversation" button in sidebar to import previously exported JSON conversations.

---

### 5. Architectural & Security Considerations

1. **Path Validation on Workspace Switching**:
   - `POST /api/workspace` must resolve paths against `resolve(path)` and verify existence using `statSync(path).isDirectory()`.
   - Prevent arbitrary non-directory paths from being set.
2. **Loopback Protection**:
   - Host checks and `x-frontier-token` nonce validation remain strictly enforced on all new endpoints (`/api/workspace`, export/import).
3. **Sensitive Data Redaction**:
   - Exported Markdown/JSON files must strip internal OAuth tokens or credentials; exports contain only conversation text, settings, and tool metadata.
4. **OAuth State Isolation**:
   - Concurrent login attempts across providers remain completely isolated using independent stores (`auth.json` vs `auth.json.openai`).

---

### 6. Testing & Quality Assurance Plan

1. **Unit & Translation Tests**:
   - Test OpenAI image resolution with mocked attachment stores.
   - Test `ResponsesStreamTranslator` capturing encrypted reasoning and replaying via `reasoningFor`.
   - Test OAuth callback origin matching with `127.0.0.1` vs `localhost`.
2. **CLI Tests**:
   - Test CLI argument parsing for `--provider openai` and `--cwd`.
3. **Integration Tests**:
   - Test `/api/workspace` endpoint validation (valid dir, invalid dir, path traversal safety).
   - Test conversation export serialization.
4. **Regression Verification**:
   - Run complete `npm run verify` suite (TypeScript build, package check, all unit tests).
