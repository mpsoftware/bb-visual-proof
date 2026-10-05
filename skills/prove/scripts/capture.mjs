#!/usr/bin/env node
// Capture browser evidence for a flow: a full-page screenshot per checkpoint,
// a video of the whole run and a manifest. Run it from the project root; it
// uses the project's installed Playwright (`playwright` or `@playwright/test`).
//
//   node <skill-dir>/scripts/capture.mjs flow.json <evidence-dir> [--headed]
//
// flow.json shape: { name, baseUrl, viewport?, steps: [ ...actions ] }
// actions: { goto: "/path" } | { click: "sel" } | { fill: "sel", value } |
//          { press: "sel", key } | { setInputFiles: "sel", files: [..] } |
//          { waitFor: "sel" } | { waitState: "networkidle" } | { waitMs: 500 } |
//          { checkpoint: "id" }   // saves <evidence-dir>/<id>.png (full page)
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [flowPath, evidenceDirArg, ...rest] = process.argv.slice(2)
if (!flowPath || !evidenceDirArg || rest.some((arg) => arg !== '--headed')) {
  console.error('usage: capture.mjs <flow.json> <evidence-dir> [--headed]')
  process.exit(2)
}

// Resolve Playwright from the working directory, so the script also works when
// the skill is installed outside the project.
async function loadChromium() {
  const require = createRequire(join(process.cwd(), 'noop.js'))
  for (const name of ['playwright', '@playwright/test']) {
    try {
      const mod = await import(pathToFileURL(require.resolve(name)).href)
      const chromium = mod.chromium ?? mod.default?.chromium
      if (chromium) return chromium
    } catch { /* try the next package */ }
  }
  console.error('Playwright not found. Install `playwright` or `@playwright/test` in the project and run from its root.')
  process.exit(2)
}

const CHECKPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const headed = rest.includes('--headed')
const evidenceDir = resolve(evidenceDirArg)
const flow = JSON.parse(await readFile(flowPath, 'utf8'))
const baseUrl = flow.baseUrl ?? 'http://127.0.0.1:3000'
const viewport = flow.viewport ?? { width: 1280, height: 900 }
const chromium = await loadChromium()

await mkdir(evidenceDir, { recursive: true })
const videoDir = join(evidenceDir, 'video')
await mkdir(videoDir, { recursive: true })

const browser = await chromium.launch({ headless: !headed })
const context = await browser.newContext({
  viewport,
  recordVideo: { dir: videoDir, size: viewport },
})
const page = await context.newPage()

const checkpoints = []
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

async function shoot(id) {
  if (!CHECKPOINT_ID.test(id)) throw new Error(`invalid checkpoint id: ${JSON.stringify(id)}`)
  const file = join(evidenceDir, `${id}.png`)
  await page.screenshot({ path: file, fullPage: true })
  checkpoints.push({ id, screenshot: `${id}.png` })
  console.log(`  ✓ checkpoint ${id} -> ${id}.png`)
}

let failedStep = null
let index = -1
try {
  for (const step of flow.steps) {
    index += 1
    if (step.goto !== undefined) {
      const url = /^https?:\/\//.test(step.goto) ? step.goto : baseUrl + step.goto
      await page.goto(url, { waitUntil: 'domcontentloaded' })
    } else if (step.click !== undefined) {
      await page.locator(step.click).first().click({ timeout: 15000 })
    } else if (step.fill !== undefined) {
      await page.locator(step.fill).first().fill(String(step.value ?? ''))
    } else if (step.press !== undefined) {
      await page.locator(step.press).first().press(step.key)
    } else if (step.setInputFiles !== undefined) {
      await page.locator(step.setInputFiles).first().setInputFiles(step.files)
    } else if (step.waitFor !== undefined) {
      await page.locator(step.waitFor).first().waitFor({ timeout: 15000 })
    } else if (step.waitState !== undefined) {
      await page.waitForLoadState(step.waitState, { timeout: 15000 })
    } else if (step.waitMs !== undefined) {
      await page.waitForTimeout(step.waitMs)
    } else if (step.checkpoint !== undefined) {
      await shoot(step.checkpoint)
    } else {
      throw new Error(`unrecognized step: ${JSON.stringify(step)}`)
    }
  }
} catch (err) {
  failedStep = { index, error: err?.message ?? String(err) }
  // Best effort: capture what the screen looked like when it broke.
  try {
    await page.screenshot({ path: join(evidenceDir, '_failure.png'), fullPage: true })
    checkpoints.push({ id: '_failure', screenshot: '_failure.png' })
  } catch {}
  console.error(`  ✗ step ${index} failed: ${failedStep.error}`)
}

await context.close() // finalizes the video
await browser.close()

const manifest = {
  name: flow.name ?? 'unnamed',
  baseUrl,
  checkpoints,
  consoleErrors,
  failedStep,
  video: 'video/',
}
await writeFile(join(evidenceDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`\nmanifest -> ${join(evidenceDir, 'manifest.json')}`)
process.exit(failedStep ? 1 : 0)
