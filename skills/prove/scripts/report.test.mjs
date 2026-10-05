import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const report = fileURLToPath(new URL('./report.mjs', import.meta.url))

function fixture(t, verdicts, criteria) {
  const dir = mkdtempSync(join(tmpdir(), 'prove-report-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    name: 'Checkout', checkpoints: [{ id: 'checkout', screenshot: 'checkout.png' }],
    consoleErrors: [], failedStep: null, video: 'video/',
  }))
  writeFileSync(join(dir, 'verdicts.json'), JSON.stringify(verdicts))
  const args = [report, dir, join(dir, 'verdicts.json')]
  if (criteria) {
    writeFileSync(join(dir, 'criteria.json'), JSON.stringify({ feature: 'Checkout', criteria }))
    args.push(join(dir, 'criteria.json'))
  }
  const result = spawnSync(process.execPath, args, {
    cwd: dir, encoding: 'utf8',
  })
  return {
    result,
    verdict: JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')),
    markdown: readFileSync(join(dir, 'evidence.md'), 'utf8'),
  }
}

test('text report preserves acceptance evidence without media embeds or links', (t) => {
  const f = fixture(t, [{ id: 'checkout', met: 'pass', observed: 'Order confirmed' }])
  assert.equal(f.result.status, 0, f.result.stderr)
  assert.equal(f.verdict.passed, true)
  assert.equal(f.verdict.criteria[0].screenshot, 'checkout.png')
  assert.match(f.markdown, /Order confirmed/)
  assert.match(f.markdown, /Proof item:.*checkout\.png/)
  assert.match(f.markdown, /BB Visual proof panel/)
  assert.doesNotMatch(f.markdown, /!\[|\]\(.*\.(png|webm|mp4)|Video: `video\//)
})

test('failed and inconsistent verdicts remain unproven', (t) => {
  const f = fixture(t, { runs: [
    [{ id: 'checkout', met: 'fail', reasoning: 'Order missing' }],
    [{ id: 'checkout', met: 'pass' }],
  ] })
  assert.equal(f.result.status, 1)
  assert.equal(f.verdict.passed, false)
  assert.equal(f.verdict.criteria[0].passAtK, true)
  assert.equal(f.verdict.criteria[0].passPowK, false)
  assert.match(f.markdown, /NOT PROVEN/)
})

test('a listed criterion without a verdict keeps the report unproven', (t) => {
  const f = fixture(t, [{ id: 'checkout', met: 'pass' }], [
    { id: 'checkout', checkpoint: 'checkout' },
    { id: 'confirmation', checkpoint: 'checkout' },
  ])
  assert.equal(f.result.status, 1)
  assert.equal(f.verdict.passed, false)
  assert.deepEqual(f.verdict.counts, { pass: 1, fail: 0, unknown: 1, total: 2 })
  assert.match(f.markdown, /UNKNOWN — confirmation/)
})
