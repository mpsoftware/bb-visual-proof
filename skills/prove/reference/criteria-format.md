# criteria.json format

Each criterion is a pass/fail statement precise enough that two reviewers would
reach the same verdict. The `rubric` describes what the screenshot at
`checkpoint` must visibly show to pass.

```json
{
  "feature": "order summary on the checkout page",
  "criteria": [
    {
      "id": "summary-visible",
      "given": "a cart with two items",
      "when": "the checkout page renders on desktop",
      "then": "an order summary lists both items and the total",
      "checkpoint": "checkout",
      "rubric": "The screenshot shows a summary panel next to the address form with two item rows and a total row. There is no empty placeholder where the summary should be."
    }
  ]
}
```

Rules:

- `id`: kebab-case and unique.
- `given`, `when`, `then`: one short clause each; this is the human-readable
  specification.
- `checkpoint`: a `checkpoint` id from `flow.json`. Without it, the judge reads
  the screenshot whose id equals the criterion `id`.
- `rubric`: the visible state only. Say what must appear and what must not
  (for example "no error banner"). Never "the change was made".
- Add negative criteria for bug fixes: the broken state must be absent.

A complete example lives in [`assets/criteria.example.json`](../assets/criteria.example.json).
