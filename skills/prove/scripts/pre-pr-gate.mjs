#!/usr/bin/env node
// Claude Code PreToolUse(Bash) gate for the prove skill.
//
// Blocks `gh pr create` for UI/user-facing changes UNLESS the current commit was
// checked with prove (a `.prove/PROVEN` marker matching HEAD). Every other
// command passes through untouched.
//
// Works in any repository: auto-detects the base branch
// (PROVE_BASE → origin's default HEAD → first of main/master/staging/develop)
// and recognizes UI paths across Next/Vite/Nuxt/Astro/SvelteKit layouts.
//
// Wiring: register as a PreToolUse hook (matcher "Bash") in your Claude Code settings.
// Escape hatch: `PROVE_SKIP=1 gh pr create ...`. Per-repo overrides: PROVE_BASE, PROVE_UI_REGEX.
// Fail-open: any error or undecidable state -> allow (never break real work).
// Git runs without a shell: ref names may contain shell metacharacters.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

export const UI_DIR_REGEX = /(^|\/)(app|src\/app|components|src\/components|pages|src\/pages|messages|locales|layouts|src\/routes)\//i
export const UI_FILE_REGEX = /\.(vue|svelte|astro)$/i

// Pure decision core — all IO injected, so it is unit-testable without a real repo.
//   git(args) -> stdout string ('' on failure)   exists(path) -> bool   read(path) -> string
// Returns { action: 'allow' } or { action: 'block', message }.
export function decideGate({ cmd = '', env = {}, git, exists, read }) {
  if (!/\bgh\s+pr\s+create\b/.test(cmd)) return { action: 'allow' }
  if (env.PROVE_SKIP === '1' || /\bPROVE_SKIP=1\b/.test(cmd)) return { action: 'allow' }

  // `base` names the branch in the message; `rev` is the unambiguous revision to diff against.
  let base = (env.PROVE_BASE || '').trim()
  let rev = base
  if (!base) {
    const originHead = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    if (originHead.startsWith('refs/remotes/origin/')) {
      rev = originHead
      base = originHead.slice('refs/remotes/origin/'.length)
    }
  }
  if (!base) {
    for (const c of ['main', 'master', 'staging', 'develop']) {
      if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${c}`])) { base = c; rev = `refs/heads/${c}`; break }
    }
  }
  if (!base) return { action: 'allow' } // undecidable base → fail-open

  const changed = git(['diff', '--name-only', '--end-of-options', `${rev}...HEAD`])
  if (!changed) return { action: 'allow' }

  let uiRegex = UI_DIR_REGEX
  if (env.PROVE_UI_REGEX) { try { uiRegex = new RegExp(env.PROVE_UI_REGEX) } catch { /* keep default */ } }
  const uiTouched = changed.split('\n').some((f) => f && (uiRegex.test(f) || UI_FILE_REGEX.test(f)))
  if (!uiTouched) return { action: 'allow' }

  const head = git(['rev-parse', 'HEAD'])
  const proven = exists('.prove/PROVEN') ? read('.prove/PROVEN').trim() : ''
  if (head && proven === head) return { action: 'allow' }

  return {
    action: 'block',
    message: [
      'A UI-affecting change is being opened as a PR but this commit was not verified with /prove.',
      `(base: ${base}) Run the /prove skill against the running app, attach evidence, then stamp the commit:`,
      '  mkdir -p .prove && git rev-parse HEAD > .prove/PROVEN',
      'Override for a trivial/non-visual change: PROVE_SKIP=1 gh pr create ...',
    ].join('\n'),
  }
}

// CLI entry: only runs when invoked directly (not when imported by the test).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const ALLOW = 0
  const BLOCK = 2
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'))
    const git = (args) => {
      try {
        return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      } catch {
        return ''
      }
    }
    const decision = decideGate({
      cmd: payload?.tool_input?.command ?? '',
      env: process.env,
      git,
      exists: (p) => existsSync(p),
      read: (p) => readFileSync(p, 'utf8'),
    })
    if (decision.action === 'block') {
      process.stderr.write(decision.message + '\n')
      process.exit(BLOCK)
    }
    process.exit(ALLOW)
  } catch {
    process.exit(ALLOW) // never block real work because the gate itself failed
  }
}
