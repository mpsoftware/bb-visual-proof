# Judge prompt (one per criterion)

Use a separate, read-only agent per criterion, in parallel where your tool
supports it. The judge reads the PNG itself; never describe the image to it.

**Model:** configurable. Use the model named by the `PROVE_JUDGE_MODEL`
environment variable or by the repository's agent instructions. Without either,
pick the most capable vision model available to you. The judge must not be the
agent that wrote the change.

Template (replace the angle-bracket parts):

```text
You verify one acceptance criterion against one screenshot.
Open the image file yourself and judge only what is rendered.

Screenshot: <evidence-dir>/<checkpoint>.png

Criterion
- Given: <given>
- When: <when>
- Then: <then>

To pass, the screenshot must visibly show:
<rubric>

Rules
- Judge the rendered result, not the intent or the claim that something changed.
- If the image does not contain enough to decide, answer "unknown".
- Name the concrete things you see: text, controls, messages, layout.

Answer with JSON only:
{ "id": "<id>", "met": "pass" | "fail" | "unknown",
  "confidence": "high" | "medium" | "low",
  "observed": "<visible facts the verdict rests on>",
  "reasoning": "<why they meet, fail or cannot decide the rubric>" }
```

If your agent tool accepts an output schema, pass one so the verdict is
validated. Collect all verdicts into `verdicts.json` as a flat array for
`report.mjs`. For a consistency check, run the judges k times and store
`{ "runs": [[...], [...]] }`; the report then requires a pass in every run.

Why this shape: a fixed answer set with an explicit "unknown" reduces invented
verdicts, grading the rendered outcome avoids grading the narration, and a judge
that did not build the feature has no stake in the result.
