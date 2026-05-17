# Friday Local Runtime Doctor

`scripts/ops/friday-local-runtime-doctor.mjs` is the out-of-process local
recovery surface introduced for **Phase 14.5B module_28b**.

It runs entirely outside the Friday hub process. It never calls
`/v1/auto-fix/*` and never mutates the filesystem, configuration, or
external services. It only inspects local Friday entrypoints and reports
classification + recommended next steps.

This file is a script-local README. It is **not** a docs-source-of-truth
update and does **not** modify `docs/current-source-of-truth.md`.

## Usage

```bash
npm run ops:doctor:runtime
npm run ops:doctor:runtime:report-json
node scripts/ops/friday-local-runtime-doctor.mjs --report-json --apply-low-risk
```

## Flags

| Flag | Default | Description |
|---|---|---|
| `--port`, `-p <port>` | none | Additional port to scan (e.g. `3141`). Repeatable. |
| `--url`, `-u <url>` | none | Additional base URL to scan. Repeatable. |
| `--timeout-ms <ms>` | `4000` | Per-call timeout for each probe. |
| `--total-timeout-ms <ms>` | `30000` | Wall-clock budget across all targets and iterations. The script exits with `status: "timeout_exceeded"` if exceeded. |
| `--max-iterations <n>` | `1` | Maximum scan iterations. Clamped to `[1, 10]`. |
| `--report-json` | off | Emit a single JSON report to stdout instead of human-readable text. |
| `--apply-low-risk` | off | Reports a low-risk recovery candidate per target. **Never** calls `/v1/auto-fix/*` and **never** mutates the filesystem/config. The candidate is purely informational. |

## Boundaries

- **No auto-fix HTTP call.** The script never invokes
  `/v1/auto-fix/actions/run-ready`, `/execute`, `/approve`, `/deny`, or
  `/rollback`. Those routes are gated by the Phase 14.5B bound-principal
  gate and must be called explicitly from a signed Assistant/API path.
- **No durable mutation.** `--apply-low-risk` prints candidate actions
  only. It does not write configuration, install packages, or modify state.
- **No secrets in `--report-json` output.** The JSON formatter redacts any
  field whose key matches `token.*secret`, `access_token`, `bearer`,
  `local_passphrase`, `authorization`, `secret`, `password`, or `cookie`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | A healthy integrated UI + API entrypoint was found. |
| `1` | No healthy integrated entrypoint, OR `status: "timeout_exceeded"`, OR `--apply-low-risk` printed a candidate to act on. |
