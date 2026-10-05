# Pixel comparison: no visible change intended

This path applies to UI-touching refactors, lint fixes and dependency/tooling updates,
not to intended visual changes. Use the project's installed tool and existing fixture
driver. Do not add a bespoke comparator when Playwright or pixelmatch fits.

## Capture and provenance

List the affected screens/states before running. Include changed transitions and the
responsive, empty, loading and error states affected by the code. An empty or partial
matrix cannot prove `identical: N/N`.

Resolve and record full base/head SHAs. Run the same driver against both checkouts,
with the same OS/container, browser version, headless mode, viewport, device scale,
fixtures, locale, clock and fonts. Reset fixtures between runs. Reuse auth/fixture
helpers, never real PII. Pin `timezoneId` and `locale` when creating the browser context,
and freeze browser time **before navigation**. For Playwright 1.45+:

```js
const context = await browser.newContext({
  timezoneId: 'UTC', locale: 'en-US',
  viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1,
  reducedMotion: 'reduce',
});
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-01-01T00:00:00Z'));
// Configure the project's seeded fixture/init script before navigation too.
await page.goto(targetUrl);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: imagePath, fullPage: true, animations: 'disabled' });
```

`setFixedTime` fixes `Date.now()`/`new Date()` while timers continue running. For
timer-driven UI, use `page.clock.install({ time })` before navigation instead, then
the same deterministic timer advances and `pauseAt` capture point on both runs.
Do not combine the two clock modes. Wait for application readiness before capture.
With an older Playwright, reuse the project's existing time mock; never silently use
wall-clock time. Sources: [Clock API](https://playwright.dev/docs/api/class-clock)
and [browser context options](https://playwright.dev/docs/api/class-browser#browser-new-context).

Browser clock mocking does not freeze SSR time. Seed fixed fixture timestamps (including
relative-age inputs) and use the project's server-time freeze mechanism for SSR-rendered
dates; pin server timezone/locale as needed. Seed or stub randomness with the project's
existing test fixture on both client and server, before application code executes; use
`context.addInitScript` for an existing browser seed hook when appropriate. Record the
seed and mechanism. Do not replace production randomness or auth/credential generation.

`animations: 'disabled'` controls CSS transitions, CSS animations and Web Animations,
not every JS motion source. Pause rAF/canvas/Lottie through the project's deterministic
fixture or reduced-motion hook, and pause/seek video to the same frame. Verify that the
hook actually stops motion; reduced-motion preference alone is not proof. Record each
pause mechanism, frame/seek position and clock advance. If a screen cannot be stabilized,
mark that state `not comparable: <reason>` and use the normal visual-proof upload path
with before/after evidence (and diff when meaningful), not upload suppression. Reviewers
inspect that state through the panel. Compare the remaining comparable states normally;
do not count non-comparable states in `identical: N/N` or claim overall unchanged UI.
This documented motion fallback does not excuse missing images, stale SHAs or tool errors.

Both image directories, diff output and any comparison baselines stay outside git,
such as thread storage or a task-owned temporary directory. Preserve the unmodified
base artifacts and capture metadata. No masks or CSS that hide affected elements;
stabilize volatile fixtures rather than hiding regressions. Keep the same comparison
matrix, driver and settings on base and head.

## Tool-first routes

Check installed package versions and the project's existing visual-test config.
The options below must override relaxed project defaults. Record all tolerances,
including whether antialiasing is ignored; a green result with unknown defaults is
not proof. Use zero differing pixels by default. Do not tune tolerances after a diff.

### Existing Playwright visual tests

Reuse the fixture-backed test and put snapshots and test results outside git through
the project's `snapshotPathTemplate` and `outputDir`. Point both base and head runs
at that same base snapshot directory. For example, set the assertion explicitly:

```js
await expect(page).toHaveScreenshot('affected-state.png', {
  animations: 'disabled', fullPage: true,
  threshold: 0, maxDiffPixels: 0, maxDiffPixelRatio: 0,
});
```

Generate snapshots once on the recorded **base**, then compare the **head** with
`--update-snapshots=none`. Never update snapshots during the head comparison; a
missing baseline is a failure, not permission to create one. Keep the same installed
Playwright/browser version for both captures. Keep expected, actual and diff artifacts
from a failing comparison and the machine-readable test report.

Playwright's comparator has antialiasing behavior as well as numeric thresholds;
record it explicitly. If it does not satisfy the tight tolerance for this task,
compare the captured PNGs with installed pixelmatch using `includeAA: true` below.
Do not call a perceptual/antialiasing-tolerant result byte-identical.

Sources: [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots)
and [screenshot assertion options](https://playwright.dev/docs/api/class-pageassertions#page-assertions-to-have-screenshot-1).

### Existing pixelmatch CLI

With pixelmatch already installed in the target project, compare each expected pair:

```bash
./node_modules/.bin/pixelmatch /path/to/base/state.png /path/to/head/state.png /path/to/diff/state.png 0 true
```

This sets color threshold `0` and includes antialiasing pixels. Require **zero**
different pixels for every pair; record counts and exit codes. The CLI inspected for
this recipe (pixelmatch 7.2.0) exits `0` for identical and `66` for different pixels;
`65` means dimension mismatch, `64` invalid usage. Other errors are not a pass.
Verify the installed version's contract before relying on these codes. Do not use
shell constructs that swallow a mismatch exit code and report success.

A dimension mismatch is a visual difference. Use the project's dimension-aware
diff tool (such as Playwright's expected/actual/diff output), or existing PNG tooling
to pad copies to a common canvas before generating the diff. Retain the original
dimensions and originals; padding cannot turn a dimension change into identical.
If no diff can be produced, report the proof gap and do not approve the claim.

Source: [pixelmatch CLI](https://github.com/mapbox/pixelmatch/blob/main/bin/pixelmatch).
If neither installed route fits, explain why before adding the minimal adapter;
do not silently skip comparison or install a new production dependency.

## Report and review

The PR's text proof names each screen/state, full base/head SHAs, environment/fixtures,
tool/version, every threshold, command, pair count and per-pair output. Record frozen
browser time and clock mode/advances, timezone/locale, fixed SSR timestamps/server-time
mechanism, random seed/hooks and CSS/JS motion controls or non-comparable states. Example:

```text
Intent: no visible change (lint-only UI edit)
Base: FULL_BASE_SHA; head: FULL_PR_HEAD_SHA
Capture: SAME_ENVIRONMENT, viewport/scale, fixture revision, fonts, animations disabled
Clock: 2026-01-01T00:00:00Z, setFixedTime before navigation; timezoneId=UTC; locale=en-US
SSR: fixed fixture timestamps and PROJECT_SERVER_TIME_FREEZE; server timezone/locale
Random: PROJECT_SEED and CLIENT/SERVER_FIXTURE_HOOKS before application code
Motion: CSS disabled; PROJECT_RAF_CANVAS_LOTTIE_PAUSE; video seek frame; non-comparable: none
Tool: pixelmatch 7.2.0; threshold=0; includeAA=true; allowed different pixels=0
Pairs: desktop/loading 0 pixels; desktop/loaded 0 pixels; mobile/loaded 0 pixels
Result: identical: 3/3; all comparison commands exit 0
Panel upload: none
Artifacts/output: REVIEWER_ACCESSIBLE_LOCATION; reproduce: EXACT_COMMANDS
```

All pairs identical: no panel upload and no visual notification. Keep the artifacts
and output accessible to the reviewer without embedding/committing media. Reviewer
checks coverage, provenance and output and can rerun the comparison. New head means
new comparison. Missing/incomplete comparison for comparable states is a blocker;
documented non-comparable motion states require panel evidence as described above.

Any difference: say `no visible change claim failed`, then upload **before, after and
diff for every differing screen/state** for the exact head with the normal `prove`
flow. Fix regressions and compare again. A comparison error must be resolved before
claiming identical; ordinary before/after evidence alone does not prove no change.
Do not use upload suppression to bypass an open send-back from the panel: its
findings stay open until a revised proof resolves them.
