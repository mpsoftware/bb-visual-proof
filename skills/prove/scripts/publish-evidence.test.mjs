// CLI regressions use isolated command stubs; no git, GitHub or BB writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const publish = fileURLToPath(new URL('./publish-evidence.mjs', import.meta.url))
const head = 'a'.repeat(40)

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prove-publish-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const evidence = join(root, 'proof $(touch injected); with spaces')
  const log = join(root, 'calls.jsonl')
  mkdirSync(bin)
  mkdirSync(evidence)
  writeFileSync(log, '')
  for (const command of ['git', 'gh', 'bb']) {
    writeFileSync(join(bin, command), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.PROVE_TEST_LOG, JSON.stringify({command: ${JSON.stringify(command)}, args}) + '\\n');
if (${JSON.stringify(command)} === 'git') {
  if (JSON.stringify(args) !== JSON.stringify(['rev-parse', 'HEAD'])) process.exit(9);
  console.log(${JSON.stringify(head)});
} else if (${JSON.stringify(command)} === 'gh') {
  if (args[0] === 'repo' && args[1] === 'view') console.log('acme/shop');
  else if (args[0] === 'pr' && args[1] === 'view') console.log(${JSON.stringify(options.remoteHead ?? head)});
  else process.exit(9);
} else {
  if (args[0] !== 'visual-proof' || args[1] !== 'add') process.exit(9);
  if (process.env.PROVE_TEST_BB_FAIL === '1') {
    console.error('SENTINEL_PRIVATE_COMMAND_OUTPUT'); process.exit(1);
  }
}
`, { mode: 0o755 })
  }
  return {
    evidence,
    run: (args) => spawnSync(process.execPath, [publish, evidence, ...args], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: bin, PROVE_TEST_LOG: log,
        PROVE_TEST_BB_FAIL: options.fail ? '1' : '0' },
    }),
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
  }
}

test('uploads the whole capture directory through BB with the exact pushed head', (t) => {
  const f = fixture(t)
  const result = f.run(['acme/shop#123'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(f.calls(), [
    { command: 'git', args: ['rev-parse', 'HEAD'] },
    { command: 'gh', args: ['pr', 'view', '123', '--repo', 'acme/shop', '--json', 'headRefOid', '-q', '.headRefOid'] },
    { command: 'bb', args: ['visual-proof', 'add', 'acme/shop#123', f.evidence, '--sha', head] },
  ])
})

test('numeric PR resolves the current repository; dry-run does not upload', (t) => {
  const f = fixture(t)
  const result = f.run(['123', '--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /acme\/shop#123/)
  assert.equal(f.calls().length, 3)
  assert.ok(f.calls().every((call) => call.command !== 'bb'))
})

test('unpushed local head blocks publication', (t) => {
  const f = fixture(t, { remoteHead: 'b'.repeat(40) })
  const result = f.run(['acme/shop#123'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Push before publishing/)
  assert.ok(f.calls().every((call) => call.command !== 'bb'))
})

test('invalid PRs and removed image-branch options never mutate anything', (t) => {
  const f = fixture(t)
  for (const args of [['123oops'], ['-1'], ['acme/shop#0'], ['123', '--branch', 'prove-evidence'], ['123', '--edit-last']]) {
    const result = f.run(args)
    assert.equal(result.status, 2, result.stderr)
  }
  assert.deepEqual(f.calls(), [])
})

test('publication failures are nonzero and do not echo external output', (t) => {
  const f = fixture(t, { fail: true })
  const result = f.run(['acme/shop#123'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Evidence publication failed/)
  assert.doesNotMatch(result.stdout + result.stderr, /SENTINEL_PRIVATE_COMMAND_OUTPUT/)
})

test('missing evidence directory blocks publication', (t) => {
  const f = fixture(t)
  rmSync(f.evidence, { recursive: true })
  const result = f.run(['acme/shop#123'])
  assert.equal(result.status, 1)
  assert.deepEqual(f.calls(), [])
})
