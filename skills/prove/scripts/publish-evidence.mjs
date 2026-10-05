#!/usr/bin/env node
// Upload captured media to BB for the pushed PR head. The plugin owns the
// summary comment and panel link; no media is committed or posted to GitHub.
// Usage: node publish-evidence.mjs <evidence-dir> <owner/repo#N|pr-number> [--dry-run]
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'

const [dir, prArg, ...rest] = process.argv.slice(2)
if (!dir || !prArg || rest.some((arg) => arg !== '--dry-run')) {
  console.error('usage: publish-evidence.mjs <evidence-dir> <owner/repo#N|pr-number> [--dry-run]')
  process.exit(2)
}

const run = (command, args) => execFileSync(command, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

try {
  const evidenceDir = resolve(dir)
  if (!statSync(evidenceDir).isDirectory()) throw new Error('Evidence must be a directory.')
  let pr = prArg
  if (/^[1-9]\d*$/.test(prArg)) {
    const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
    pr = `${repo}#${prArg}`
  }
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(pr)
  if (!match) {
    console.error('PR must be owner/repo#N or a positive PR number.')
    process.exit(2)
  }
  const [, repo, number] = match
  const head = run('git', ['rev-parse', 'HEAD'])
  const pushedHead = run('gh', ['pr', 'view', number, '--repo', repo,
    '--json', 'headRefOid', '-q', '.headRefOid'])
  if (!/^[a-f0-9]{40,64}$/.test(head) || pushedHead !== head) {
    console.error('Local HEAD must match the pushed PR head. Push before publishing proof.')
    process.exit(1)
  }
  if (rest.includes('--dry-run')) {
    console.log(`[dry-run] bb visual-proof add ${pr} <evidence-dir> --sha ${head}`)
  } else {
    run('bb', ['visual-proof', 'add', pr, evidenceDir, '--sha', head])
    console.log(`Visual proof uploaded for ${pr} at ${head}; see the plugin summary comment.`)
  }
} catch {
  // External command errors can contain credentials or captured application data.
  console.error('Evidence publication failed. Check the directory, GitHub access and BB visual-proof availability.')
  process.exit(1)
}
