// Unit tests for the prove pre-PR gate decision core.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideGate } from './pre-pr-gate.mjs'

const HEAD = 'abc123def456'

// Build a fake `git(cmd)` from a table of substring → output.
function fakeGit(table) {
  return (cmd) => {
    for (const [needle, out] of Object.entries(table)) {
      if (cmd.includes(needle)) return out
    }
    return ''
  }
}

// Default: origin default branch = main, HEAD known.
const gitOnMain = fakeGit({
  'refs/remotes/origin/HEAD': 'origin/main',
  'git diff --name-only main...HEAD': 'src/app/page.tsx\nlib/util.ts',
  'git rev-parse HEAD': HEAD,
})

const deps = (over = {}) => ({
  cmd: 'gh pr create --base main',
  env: {},
  git: gitOnMain,
  exists: () => false,
  read: () => '',
  ...over,
})

test('non-PR command passes through', () => {
  assert.equal(decideGate(deps({ cmd: 'git status' })).action, 'allow')
})

test('PROVE_SKIP=1 in env allows', () => {
  assert.equal(decideGate(deps({ env: { PROVE_SKIP: '1' } })).action, 'allow')
})

test('PROVE_SKIP=1 inlined on the command allows', () => {
  assert.equal(decideGate(deps({ cmd: 'PROVE_SKIP=1 gh pr create' })).action, 'allow')
})

test('non-UI changes allow (backend-only PR)', () => {
  const git = fakeGit({
    'refs/remotes/origin/HEAD': 'origin/main',
    'git diff --name-only main...HEAD': 'lib/db.ts\nscripts/ingest.py\nREADME.md',
    'git rev-parse HEAD': HEAD,
  })
  assert.equal(decideGate(deps({ git })).action, 'allow')
})

test('UI change without PROVEN marker blocks', () => {
  const d = decideGate(deps())
  assert.equal(d.action, 'block')
  assert.match(d.message, /not verified with \/prove/)
})

test('UI change with matching PROVEN marker allows', () => {
  const d = decideGate(deps({ exists: (p) => p === '.prove/PROVEN', read: () => HEAD + '\n' }))
  assert.equal(d.action, 'allow')
})

test('UI change with stale PROVEN marker blocks', () => {
  const d = decideGate(deps({ exists: () => true, read: () => 'oldcommit0000' }))
  assert.equal(d.action, 'block')
})

test('framework single-file component (.vue) counts as UI', () => {
  const git = fakeGit({
    'refs/remotes/origin/HEAD': 'origin/main',
    'git diff --name-only main...HEAD': 'app/HomeView.vue',
    'git rev-parse HEAD': HEAD,
  })
  assert.equal(decideGate(deps({ git })).action, 'block')
})

test('falls back to a common base branch when origin/HEAD is unknown', () => {
  const git = fakeGit({
    'git rev-parse --verify --quiet staging': 'stagingsha',
    'git diff --name-only staging...HEAD': 'components/Button.tsx',
    'git rev-parse HEAD': HEAD,
  })
  const d = decideGate(deps({ git }))
  assert.equal(d.action, 'block')
  assert.match(d.message, /base: staging/)
})

test('undecidable base (no origin, no common branch) fails open', () => {
  const git = fakeGit({ 'git rev-parse HEAD': HEAD }) // everything else ''
  assert.equal(decideGate(deps({ git })).action, 'allow')
})

test('PROVE_BASE override is honored', () => {
  const git = fakeGit({
    'git diff --name-only develop...HEAD': 'src/pages/index.tsx',
    'git rev-parse HEAD': HEAD,
  })
  const d = decideGate(deps({ env: { PROVE_BASE: 'develop' }, git }))
  assert.equal(d.action, 'block')
  assert.match(d.message, /base: develop/)
})
