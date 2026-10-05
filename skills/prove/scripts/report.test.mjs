import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const report = fileURLToPath(new URL('./report.mjs', import.meta.url))
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

function fixture(t, verdicts, { criteria, manifest = {}, files = { 'checkout.png': PNG } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prove-report-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    name: 'Checkout', checkpoints: [{ id: 'checkout', screenshot: 'checkout.png' }],
    consoleErrors: [], failedStep: null, video: 'video/', ...manifest,
  }))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
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
    dir,
    result,
    verdict: JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')),
    markdown: readFileSync(join(dir, 'evidence.md'), 'utf8'),
  }
}

const PASS = [{ id: 'checkout', met: 'pass', observed: 'Order confirmed' }]

function assertNotProven(f, pattern) {
  assert.equal(f.result.status, 1, f.result.stderr)
  assert.equal(f.verdict.passed, false)
  assert.match(f.markdown, /NOT PROVEN/)
  assert.doesNotMatch(f.markdown, /SOLVED/)
  assert.match(f.markdown, pattern)
}

test('text report preserves acceptance evidence without media embeds or links', (t) => {
  const f = fixture(t, PASS)
  assert.equal(f.result.status, 0, f.result.stderr)
  assert.equal(f.verdict.passed, true)
  assert.equal(f.verdict.criteria[0].screenshot, 'checkout.png')
  assert.equal(f.verdict.criteria[0].evidenceGap, null)
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
  const f = fixture(t, [{ id: 'checkout', met: 'pass' }], { criteria: [
    { id: 'checkout', checkpoint: 'checkout' },
    { id: 'confirmation', checkpoint: 'checkout' },
  ] })
  assert.equal(f.result.status, 1)
  assert.equal(f.verdict.passed, false)
  assert.deepEqual(f.verdict.counts, { pass: 1, fail: 0, unknown: 1, missingEvidence: 0, total: 2 })
  assert.match(f.markdown, /UNKNOWN — confirmation/)
})

test('a passing verdict without a manifest checkpoint is not proven', (t) => {
  const f = fixture(t, PASS, { manifest: { checkpoints: [] }, files: {} })
  assertNotProven(f, /Evidence gap:.*no checkpoint "checkout"/)
  assert.equal(f.verdict.counts.missingEvidence, 1)
})

test('a passing verdict whose screenshot file is missing is not proven', (t) => {
  const f = fixture(t, PASS, { files: {} })
  assertNotProven(f, /Evidence gap:.*checkout\.png is missing/)
})

test('an empty screenshot or one outside the evidence directory is not proven', (t) => {
  const empty = fixture(t, PASS, { files: { 'checkout.png': '' } })
  assertNotProven(empty, /checkout\.png is empty/)
  const outside = fixture(t, PASS, { manifest: { checkpoints: [{ id: 'checkout', screenshot: '../manifest.json' }] } })
  assertNotProven(outside, /outside the evidence directory/)
  const link = fixture(t, PASS, { manifest: { checkpoints: [{ id: 'checkout', screenshot: 'link.png' }] } })
  symlinkSync(join(link.dir, '..'), join(link.dir, 'link.png'))
  const linked = spawnSync(process.execPath, [report, link.dir, join(link.dir, 'verdicts.json')], { encoding: 'utf8' })
  assert.equal(linked.status, 1)
  assert.match(readFileSync(join(link.dir, 'evidence.md'), 'utf8'), /outside the evidence directory/)
})

test('a failed capture never passes, even with every verdict passing', (t) => {
  const f = fixture(t, PASS, { manifest: { failedStep: { index: 3, error: 'required step failed' } } })
  assertNotProven(f, /Capture failed at step 3: `required step failed`/)
})
