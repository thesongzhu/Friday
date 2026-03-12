# Friday vs OpenClaw Mixed Benchmark Evidence

This directory stores the first mixed-case benchmark evidence comparing Friday and OpenClaw.

## Contents

- `latest.json` — pointer metadata for the latest recorded run
- `latest.md` — human-readable summary for the latest recorded run
- `first-round-gap-analysis.md` — first full-round interpretation and gap ranking
- `next-round-gap-closeout-plan.md` — prioritized repair plan derived from the full mixed benchmark
- `<timestamp>/results.json` — structured benchmark results
- `<timestamp>/summary.md` — human-readable summary for that run
- `<timestamp>/sandboxes/...` — case sandboxes and resulting artifacts

## Interpretation

The benchmark is intended to answer:

- where Friday matches the tracked OpenClaw overlap scope
- where Friday is weaker, stronger, or intentionally bounded
- why Friday can still feel "dumb" in some scenarios

Use `./docs/ops/friday-vs-openclaw.md` together with these evidence files when explaining the result.

The current `latest.*` files reflect the first **3-repeat mixed benchmark round**. Treat them as the best current benchmark truth for Friday vs OpenClaw mixed-task parity.
