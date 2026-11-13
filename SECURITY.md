# Security

This is an experimental local application. Only the latest source revision receives fixes. The server binds to loopback (`127.0.0.1`) by default; it is not designed to be exposed directly to the public internet without additional network isolation and authentication.

Please use GitHub's private vulnerability reporting feature if it is enabled on this repository. Do not post credentials, tokens, full OAuth callback URLs, or exploitable security details in public issues.

## Threat Model & Protections

- **Local Credential Storage**: OAuth tokens are stored in `~/.config/frontier-connector/auth.json` (Claude) and `auth.json.openai` (OpenAI) using atomic writes with mode `0600` inside `0700` directories, coordinated via filesystem locks.
- **DNS Rebinding & CSRF Protection**: Both the Web UI and `/v1/*` API gateway validate `Host` headers strictly against the bound host and port. Web UI endpoints (`/api/*`) require a per-process random CSRF token (`x-frontier-token`) and matching same-origin headers.
- **Cross-Origin Browser Blocking**: Requests to `/v1/*` carrying a cross-site `Origin` header are rejected (`403`) unless explicitly configured via `allowCorsOrigins`.
- **Optional Gateway Authentication**: Passing `--gateway-key` or `FRONTIER_GATEWAY_KEY` enforces `Authorization: Bearer <key>` or `x-api-key: <key>` checks (constant-time `timingSafeEqual`) across all `/v1/*` endpoints.
- **No Credential Echoing**: Auth, OAuth, HTTP, and Web status endpoints never leak tokens or upstream secret payloads.
- **Browser Local Storage**: Web UI conversation history stays in browser local storage (`frontier.connector.v1`). Logout removes Frontier's local session without revoking provider tokens in official apps.
