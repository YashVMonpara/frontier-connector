import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// Validate npm's actual publish allowlist, including files bundled implicitly.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const output = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' })
const manifest = JSON.parse(output)
const [{ files }] = Array.isArray(manifest) ? manifest : Object.values(manifest)
const paths = files.map(file => file.path)
for (const required of [
  'LICENSE',
  'THIRD_PARTY_LICENSES',
  'dist/index.js',
  'dist/cli.js',
  'dist/connector.js',
  'dist/gateway.js',
  'dist/types.js',
  'dist/http/chat.js',
  'dist/http/gateway-translate.js',
  'web/index.html',
  'web/app.js',
  'web/styles.css',
]) {
  assert.ok(paths.includes(required), `Package is missing ${required}`)
}
for (const forbidden of ['cordis.patch.yml', 'frontier-agent.patch.yml', 'dist/agent-runtime.js', 'web/runtime.css']) {
  assert.ok(!paths.includes(forbidden), `Removed DSH artifact still in package: ${forbidden}`)
}
for (const path of paths) {
  assert.ok(!/(^|\/)(?:\.env(?:\.|$)|auth\.json|node_modules|\.git|\.lavish)(\/|$|\.)/.test(path), `Private file in package: ${path}`)
  assert.ok(!/\.(?:log|tgz)$/.test(path), `Local artifact in package: ${path}`)
}
console.log(`Package contents verified (${paths.length} files).`)
