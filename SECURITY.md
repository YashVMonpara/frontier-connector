# Security

This is an experimental local application. Only the latest source revision receives fixes. The server binds to loopback (`127.0.0.1`) by default; it is not designed to be exposed directly to the public internet without additional network isolation and authentication.

Please use GitHub's private vulnerability reporting feature if it is enabled on this repository. Do not post credentials, tokens, full OAuth callback URLs, or exploitable security details in public issues.

## Threat Model & Protections

- **Local Credential Storage**: OAuth tokens are stored in `~/.config/frontier-connector/auth.json` (Claude) and `auth.json.openai` (OpenAI) using atomic writes with mode `0600` inside `0700` directories, coordinated via filesystem locks.
- **DNS Rebinding & CSRF Protection**: Both the Web UI and `/v1/*` API gateway validate `Host` headers strictly against the bound host and port. Web UI endpoints (`/api/*`) require a per-process random CSRF token (`x-frontier-token`) and matching same-origin headers.
- **Cross-Origin Browser Blocking**: Requests to `/v1/*` carrying a cross-site `Origin` header are rejected (`403`) unless explicitly configured via `allowCorsOrigins`.
- **Optional Gateway Authentication**: Passing `--gateway-key` or `FRONTIER_GATEWAY_KEY` enforces `Authorization: Bearer <key>` or `x-api-key: <key>` checks (constant-time `timingSafeEqual`) across all `/v1/*` endpoints.
- **Network Exposure Requires a Key**: The gateway refuses to bind a non-loopback host, or to allow wildcard (`*`) CORS origins, unless a gateway key is set. Prefer `FRONTIER_GATEWAY_KEY` over `--gateway-key`, since command-line flags are visible in `ps` and shell history.
- **Resource Limits**: `/v1/*` inference is capped at 8 concurrent requests by default (`429` beyond that), and `max_tokens` and `temperature` are range-checked before any provider call.
- **Crash Resistance**: Malformed request URLs return `400`, and any unexpected handler error returns `500` instead of terminating the server.
- **Web Logout Isolation**: Logging out in the Web UI also disables the embedded gateway for that provider (including API-key mode) and cancels its in-flight requests.
- **No Credential Echoing**: Auth, OAuth, HTTP, and Web status endpoints never leak tokens or upstream secret payloads.
- **Browser Local Storage**: Web UI conversation history stays in browser local storage (`frontier.connector.v1`). Logout removes Frontier's local session without revoking provider tokens in official apps.
