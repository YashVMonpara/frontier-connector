# Contributing

Requires Node.js 22 or newer. Fork the repository, create a branch, and run:

```sh
npm ci
npm run verify
npm run web
```

Keep changes focused and describe the problem, resulting behavior, and validation in your pull request. Add regression tests for bugs and protocol changes using temporary credential stores and mocked provider responses. Tests must not require a real subscription or make paid inference requests.

Target `main` from a topic branch:
- Authentication and token stores live in `src/auth/`.
- Wire translators live in `src/translate/`.
- Adapter implementations live in `src/claude.ts` and `src/openai.ts`.
- Unified routing lives in `src/connector.ts`.
- HTTP API gateway and protocol translation live in `src/gateway.ts` and `src/http/gateway-translate.ts`.

`npm run verify` includes TypeScript checks, browser JavaScript syntax validation, unit/integration tests, and npm package-content validation.

Never commit credentials, authorization callback URLs, personal conversations, or provider response captures containing private data. Preserve upstream MIT attribution when adapting code.
