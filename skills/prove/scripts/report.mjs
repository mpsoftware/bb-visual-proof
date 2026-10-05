#!/usr/bin/env node
// Assemble a verdict and a text-only evidence report from the captured
// manifest and the per-criterion judge verdicts. Media stay local until
// publish-evidence.mjs uploads the directory to the BB Visual proof panel.
//
//   node <skill-dir>/scripts/report.mjs <evidence-dir> verdicts.json [criteria.json]
//
// verdicts.json: [{ id, met: "pass"|"fail"|"unknown", confidence?, observed?, reasoning? }]
//   For pass@k/pass^k, pass an array-of-runs instead: { runs: [[...],[...]] }
// criteria.json (optional): used to print the given/when/then next to each verdict.
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const [evidenceDirArg, verdictsPath, criteriaPath] = process.argv.slice(2)
if (!evidenceDirArg || !verdictsPath) {
  console.error('usage: report.mjs <evidence-dir> <verdicts.json> [criteria.json]')
  process.exit(2)
}
const evidenceDir = realpathSync(resolve(evidenceDirArg))
const manifest = JSON.parse(await readFile(join(evidenceDir, 'manifest.json'), 'utf8'))
const raw = JSON.parse(await readFile(verdictsPath, 'utf8'))
const criteria = criteriaPath
  ? JSON.parse(await readFile(criteriaPath, 'utf8')).criteria ?? []
  : []

// Normalize to runs[][].
const runs = Array.isArray(raw) ? [raw] : raw.runs
const k = runs.length
// Every listed criterion is judged; one without a verdict counts as unknown.
const ids = [...new Set([...criteria.map((c) => c.id), ...runs.flat().map((v) => v.id)])]
const byId = (id) => criteria.find((c) => c.id === id) ?? {}
const cpFor = (id) =>
  (manifest.checkpoints ?? []).find((c) => c.id === (byId(id).checkpoint ?? id))

// A verdict only counts with its evidence: a manifest checkpoint whose screenshot
// is a readable, non-empty file inside the evidence directory.
function evidenceGap(id) {
  const checkpoint = cpFor(id)
  if (!checkpoint) return `no checkpoint "${byId(id).checkpoint ?? id}" in manifest.json`
  if (typeof checkpoint.screenshot !== 'string' || !checkpoint.screenshot) return `checkpoint "${checkpoint.id}" has no screenshot`
  const inside = (path) => path.startsWith(evidenceDir + sep)
  const outside = `screenshot ${checkpoint.screenshot} is outside the evidence directory`
  if (!inside(resolve(evidenceDir, checkpoint.screenshot))) return outside
  try {
    const file = realpathSync(resolve(evidenceDir, checkpoint.screenshot))
    if (!inside(file)) return outside
    const stat = statSync(file)
    if (!stat.isFile() || stat.size === 0) return `screenshot ${checkpoint.screenshot} is empty or not a file`
    accessSync(file, constants.R_OK)
  } catch {
    return `screenshot ${checkpoint.screenshot} is missing or unreadable`
  }
  return null
}

const perCriterion = ids.map((id) => {
  const results = runs.map((r) => r.find((v) => v.id === id) ?? { met: 'unknown' })
  const passes = results.filter((v) => v.met === 'pass').length
  const last = results[results.length - 1]
  return {
    id,
    checkpoint: byId(id).checkpoint ?? id,
    met: last.met, // single-run verdict
    passAtK: passes >= 1, // succeeded at least once
    passPowK: passes === k, // succeeded every run
    passes,
    runs: k,
    confidence: last.confidence,
    observed: last.observed,
    reasoning: last.reasoning,
    criterion: byId(id),
    screenshot: cpFor(id)?.screenshot ?? null,
    evidenceGap: evidenceGap(id),
  }
})

// A failed capture or a verdict without evidence never passes.
const passed =
  !manifest.failedStep &&
  perCriterion.length > 0 &&
  perCriterion.every((c) => !c.evidenceGap && (k > 1 ? c.passPowK : c.met === 'pass'))

const verdict = {
  passed,
  bar: k > 1 ? 'pass^k (every run)' : 'single run',
  k,
  counts: {
    pass: perCriterion.filter((c) => c.met === 'pass').length,
    fail: perCriterion.filter((c) => c.met === 'fail').length,
    unknown: perCriterion.filter((c) => c.met === 'unknown').length,
    missingEvidence: perCriterion.filter((c) => c.evidenceGap).length,
    total: perCriterion.length,
  },
  consoleErrors: manifest.consoleErrors ?? [],
  failedStep: manifest.failedStep ?? null,
  criteria: perCriterion,
}
await writeFile(join(evidenceDir, 'verdict.json'), JSON.stringify(verdict, null, 2))

const badge = (c) => (c.evidenceGap ? '⚠️ NO EVIDENCE' : c.met === 'pass' ? '✅ PASS' : c.met === 'fail' ? '❌ FAIL' : '⚠️ UNKNOWN')
const md = []
md.push(`# Evidence — ${manifest.name}`)
md.push('')
md.push(`**Verdict: ${passed ? '✅ SOLVED' : '❌ NOT PROVEN'}** — ${verdict.counts.pass}/${verdict.counts.total} criteria pass` + (k > 1 ? ` (bar: pass^${k})` : '') + '.')
if (manifest.failedStep) md.push(`\n> ❌ Capture failed at step ${manifest.failedStep.index ?? '?'}: \`${manifest.failedStep.error}\`. The run is not proven.`)
if (verdict.counts.missingEvidence) md.push(`\n> ❌ ${verdict.counts.missingEvidence} criterion verdict(s) without a readable screenshot.`)
if ((manifest.consoleErrors ?? []).length) md.push(`\n> ⚠️ ${manifest.consoleErrors.length} console error(s) during the run.`)
md.push('')
for (const c of perCriterion) {
  md.push(`## ${badge(c)} — ${c.id}`)
  if (c.criterion?.given) md.push(`- **Given** ${c.criterion.given}`)
  if (c.criterion?.when) md.push(`- **When** ${c.criterion.when}`)
  if (c.criterion?.then) md.push(`- **Then** ${c.criterion.then}`)
  if (k > 1) md.push(`- **Consistency:** ${c.passes}/${c.runs} runs passed (pass@${k}=${c.passAtK}, pass^${k}=${c.passPowK})`)
  if (c.observed) md.push(`- **Observed:** ${c.observed}`)
  if (c.reasoning) md.push(`- **Judge:** ${c.reasoning}`)
  if (c.evidenceGap) md.push(`- **Evidence gap:** ${c.evidenceGap}`)
  else if (c.screenshot) md.push(`- **Proof item:** \`${c.screenshot}\` (BB Visual proof panel)`)
  md.push('')
}
md.push(`---`)
md.push(`Media: BB Visual proof panel after publication · raw verdict: \`verdict.json\` · captured ${new Date().toISOString().slice(0, 10)}`)
await writeFile(join(evidenceDir, 'evidence.md'), md.join('\n'))

console.log(`verdict -> ${join(evidenceDir, 'verdict.json')} (passed=${passed})`)
console.log(`report  -> ${join(evidenceDir, 'evidence.md')}`)
process.exit(passed ? 0 : 1)
