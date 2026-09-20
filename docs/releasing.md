# Release process

The default development branch is `main`. Prepare changes on a topic branch and
merge only after CI succeeds. This repository does not automatically publish to npm.

1. Install the locked dependency tree with `npm ci` on Node.js 22 or 24.
2. Run `npm run verify` for type checks, browser syntax, tests, and package checks.
3. Review the diff and package file list for credentials, local state, and unrelated files.
4. Update `CHANGELOG.md`. For a versioned release, update both package manifests
   with `npm version <version> --no-git-tag-version` and rerun verification.
5. Merge into `main`, push, and wait for both CI matrix jobs to pass.
6. Only when publishing is explicitly intended, create the matching version tag
   and GitHub release. Publish the reviewed tarball separately if npm distribution
   is desired.

Mocked tests verify protocol behavior; they do not prove live account compatibility.
For a live smoke test, use a disposable workspace, connect a provider, ask it to
print a harmless marker with a tool, verify the activity trace, and test stop/logout.
Do not include the resulting credentials or conversation in a commit.
