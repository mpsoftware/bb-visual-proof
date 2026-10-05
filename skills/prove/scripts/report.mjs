#!/usr/bin/env node
// Assemble a verdict + human-readable evidence report from the captured
// manifest and the per-criterion judge verdicts. Media stays local until
// publish-evidence.mjs uploads the directory to the BB Visual proof panel.
//
//   node <skill-dir>/scripts/report.mjs <evidence-dir> verdicts.json [criteria.json]
//
// verdicts.json: [{ id, met: "pass"|"fail"|"unknown", confidence?, observed?, reasoning? }]
//   For pass@k/pass^k, pass an array-of-runs instead: { runs: [[...],[...]] }
// criteria.json (optional): used to print the given/when/then next to each verdict.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const [evidenceDirArg, verdictsPath, criteriaPath] = process.argv.slice(2)
if (!evidenceDirArg || !verdictsPath) {
  console.error('usage: report.mjs <evidence-dir> <verdicts.json> [criteria.json]')
  process.exit(2)
}
const evidenceDir = resolve(evidenceDirArg)
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
  manifest.checkpoints.find((c) => c.id === (byId(id).checkpoint ?? id))

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
  }
})

const passed =
  perCriterion.length > 0 &&
  perCriterion.every((c) => (k > 1 ? c.passPowK : c.met === 'pass'))

const verdict = {
  passed,
  bar: k > 1 ? 'pass^k (every run)' : 'single run',
  k,
  counts: {
    pass: perCriterion.filter((c) => c.met === 'pass').length,
    fail: perCriterion.filter((c) => c.met === 'fail').length,
    unknown: perCriterion.filter((c) => c.met === 'unknown').length,
    total: perCriterion.length,
  },
  consoleErrors: manifest.consoleErrors ?? [],
  failedStep: manifest.failedStep ?? null,
  criteria: perCriterion,
}
await writeFile(join(evidenceDir, 'verdict.json'), JSON.stringify(verdict, null, 2))

const badge = (c) => (c.met === 'pass' ? '✅ PASS' : c.met === 'fail' ? '❌ FAIL' : '⚠️ UNKNOWN')
const md = []
md.push(`# Evidence — ${manifest.name}`)
md.push('')
md.push(`**Verdict: ${passed ? '✅ SOLVED' : '❌ NOT PROVEN'}** — ${verdict.counts.pass}/${verdict.counts.total} criteria pass` + (k > 1 ? ` (bar: pass^${k})` : '') + '.')
if (manifest.failedStep) md.push(`\n> ⚠️ Flow step failed during capture: \`${manifest.failedStep.error}\``)
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
  if (c.screenshot) md.push(`- **Proof item:** \`${c.screenshot}\` (BB Visual proof panel)`)
  md.push('')
}
md.push(`---`)
md.push(`Media: BB Visual proof panel after publication · raw verdict: \`verdict.json\` · captured ${new Date().toISOString().slice(0, 10)}`)
await writeFile(join(evidenceDir, 'evidence.md'), md.join('\n'))

console.log(`verdict -> ${join(evidenceDir, 'verdict.json')} (passed=${passed})`)
console.log(`report  -> ${join(evidenceDir, 'evidence.md')}`)
process.exit(passed ? 0 : 1)
