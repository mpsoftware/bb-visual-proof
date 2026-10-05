# flow.json format

The ordered browser steps `capture.mjs` runs. Keep it minimal and add a
`checkpoint` wherever a screenshot is evidence.

```json
{
  "name": "checkout summary",
  "baseUrl": "http://127.0.0.1:3000",
  "viewport": { "width": 1280, "height": 900 },
  "steps": [
    { "goto": "/checkout" },
    { "waitState": "networkidle" },
    { "checkpoint": "checkout" },
    { "click": "text=Place order" },
    { "waitFor": "role=heading[name=\"Thank you\"]" },
    { "checkpoint": "confirmation" }
  ]
}
```

Supported actions: `goto` (path or full URL), `click` (CSS, text or role
selector), `fill` with `value`, `press` with `key`, `setInputFiles` with
`files: [...]`, `waitFor` (selector), `waitState` (`"load"`,
`"domcontentloaded"` or `"networkidle"`), `waitMs`, `checkpoint` (id).

A checkpoint id becomes the file name `<id>.png`; use kebab-case ids. An
unrecognized step fails the run, so a typo cannot produce a partial proof that
looks complete.

## Authenticated flows

Do not rebuild sign-up or login inside `flow.json`. When the changed state sits
behind authentication, write a short Playwright script that reuses the project's
existing test helpers (fixtures, test users, a seeded session), reaches the
state, takes `page.screenshot({ path: '<dir>/<id>.png', fullPage: true })` at
each checkpoint, and writes the same `manifest.json` shape (`name`,
`checkpoints: [{ id, screenshot }]`, `consoleErrors`, `failedStep`) so that
`report.mjs` and `publish-evidence.mjs` work unchanged. Use test accounts only.
