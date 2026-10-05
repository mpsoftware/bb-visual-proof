// Unit tests for the prove pre-PR gate decision core, plus end-to-end runs of
// the hook against throwaway git repositories.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideGate } from './pre-pr-gate.mjs'

const HEAD = 'abc123def456'

// Build a fake `git(args)` from a table of exact argument strings → output.
function fakeGit(table) {
  return (args) => table[args.join(' ')] ?? ''
}

// Default: origin's default branch = main, HEAD known.
const gitOnMain = fakeGit({
  'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/main',
  'diff --name-only --end-of-options refs/remotes/origin/main...HEAD': 'src/app/page.tsx\nlib/util.ts',
  'rev-parse HEAD': HEAD,
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
    'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/main',
    'diff --name-only --end-of-options refs/remotes/origin/main...HEAD': 'lib/db.ts\nscripts/ingest.py\nREADME.md',
    'rev-parse HEAD': HEAD,
  })
  assert.equal(decideGate(deps({ git })).action, 'allow')
})

test('UI change without PROVEN marker blocks against the remote default branch', () => {
  const d = decideGate(deps())
  assert.equal(d.action, 'block')
  assert.match(d.message, /not verified with \/prove/)
  assert.match(d.message, /base: main\)/)
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
    'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/main',
    'diff --name-only --end-of-options refs/remotes/origin/main...HEAD': 'app/HomeView.vue',
    'rev-parse HEAD': HEAD,
  })
  assert.equal(decideGate(deps({ git })).action, 'block')
})

test('falls back to a common local base branch when origin/HEAD is unknown', () => {
  const git = fakeGit({
    'rev-parse --verify --quiet refs/heads/staging': 'stagingsha',
    'diff --name-only --end-of-options refs/heads/staging...HEAD': 'components/Button.tsx',
    'rev-parse HEAD': HEAD,
  })
  const d = decideGate(deps({ git }))
  assert.equal(d.action, 'block')
  assert.match(d.message, /base: staging/)
})

test('undecidable base (no origin, no common branch) fails open', () => {
  const git = fakeGit({ 'rev-parse HEAD': HEAD }) // everything else ''
  assert.equal(decideGate(deps({ git })).action, 'allow')
})

test('PROVE_BASE override is honored', () => {
  const git = fakeGit({
    'diff --name-only --end-of-options develop...HEAD': 'src/pages/index.tsx',
    'rev-parse HEAD': HEAD,
  })
  const d = decideGate(deps({ env: { PROVE_BASE: 'develop' }, git }))
  assert.equal(d.action, 'block')
  assert.match(d.message, /base: develop/)
})

test('every git call is an argument array, never a shell string', () => {
  const calls = []
  decideGate(deps({ git: (args) => { calls.push(args); return gitOnMain(args) } }))
  assert.ok(calls.length > 0)
  assert.ok(calls.every((args) => Array.isArray(args) && args[0] !== 'git'))
})

// End to end: the real hook in a throwaway repository with a UI change on a feature branch.
const gate = fileURLToPath(new URL('./pre-pr-gate.mjs', import.meta.url))
const MALICIOUS = 'main;touch${IFS}pwned;#'
const author = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prove-gate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git(...author, 'commit', '-q', '--allow-empty', '-m', 'base')
  git('switch', '-q', '-c', 'feature')
  mkdirSync(join(dir, 'app'))
  writeFileSync(join(dir, 'app', 'page.tsx'), 'export default function Page() { return null }\n')
  git('add', '.')
  git(...author, 'commit', '-q', '-m', 'ui change')
  return {
    dir,
    git,
    hook: (env = {}) => spawnSync(process.execPath, [gate], {
      cwd: dir, encoding: 'utf8',
      input: JSON.stringify({ tool_input: { command: 'gh pr create' } }),
      env: { ...process.env, PROVE_BASE: '', PROVE_SKIP: '', ...env },
    }),
  }
}

test('a branch name with shell metacharacters on origin/HEAD is never executed', (t) => {
  const r = repo(t)
  execFileSync('git', ['check-ref-format', '--branch', MALICIOUS])
  r.git('update-ref', `refs/remotes/origin/${MALICIOUS}`, 'main')
  r.git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${MALICIOUS}`)
  const result = r.hook()
  assert.equal(existsSync(join(r.dir, 'pwned')), false, 'shell code from the ref name ran')
  // The name is still treated as a ref: the UI change against it blocks.
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /base: main;touch/)
})

test('a PROVE_BASE with shell metacharacters is never executed', (t) => {
  const r = repo(t)
  const result = r.hook({ PROVE_BASE: MALICIOUS })
  assert.equal(existsSync(join(r.dir, 'pwned')), false, 'shell code from PROVE_BASE ran')
  assert.equal(result.status, 0) // unknown revision: fail-open, as before
})

test('the remote default branch is used even without a local copy', (t) => {
  const r = repo(t)
  r.git('update-ref', 'refs/remotes/origin/main', 'main')
  r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  r.git('branch', '-q', '-D', 'main')
  const result = r.hook()
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /base: main\)/)
  mkdirSync(join(r.dir, '.prove'))
  writeFileSync(join(r.dir, '.prove', 'PROVEN'), r.git('rev-parse', 'HEAD') + '\n')
  assert.equal(r.hook().status, 0)
})
