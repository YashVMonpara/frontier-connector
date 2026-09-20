# Contributing

Requires Node.js 22 or newer. Fork the repository, create a branch, and run:

```sh
npm ci
npm run verify
npm run web
```

Keep changes focused and describe the problem, resulting behavior, and validation in your pull request. Add regression tests for bugs and protocol changes using temporary credential stores and mocked provider responses. Tests must not require a real subscription or make paid inference requests.

Target `main` from a topic branch. Runtime process ownership belongs in
`src/runtime/harness.ts`, SDK notification mapping in `src/runtime/activity.ts`,
and HTTP chat validation in `src/http/chat.ts`. Keep the `src/agent-runtime.ts`
facade stable for existing embedders. Provider translation and authentication
remain separate in `src/translate/` and `src/auth/`.

`npm run verify` includes browser JavaScript syntax and npm package-content
validation. See [docs/releasing.md](docs/releasing.md) before preparing a release.

Never commit credentials, authorization callback URLs, personal conversations, or provider response captures containing private data. Preserve upstream MIT attribution when adapting code. Keep CLI, web, and provider-specific behavior documented separately.

For bugs, include your Node version, operating system, reproduction steps, and a sanitized error message. Report suspected security vulnerabilities privately as described in SECURITY.md.
