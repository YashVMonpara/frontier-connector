# Contributing

Requires Node.js 22 or newer. Fork the repository, create a branch, and run:

```sh
npm ci
npm run check
npm test
npm run web
```

Keep changes focused and describe the problem, resulting behavior, and validation in your pull request. Add regression tests for bugs and protocol changes using temporary credential stores and mocked provider responses. Tests must not require a real subscription or make paid inference requests.

Never commit credentials, authorization callback URLs, personal conversations, or provider response captures containing private data. Preserve upstream MIT attribution when adapting code. Keep CLI, web, and provider-specific behavior documented separately.

For bugs, include your Node version, operating system, reproduction steps, and a sanitized error message. Report suspected security vulnerabilities privately as described in SECURITY.md.
