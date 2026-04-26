# Friday Overnight Stability Gauntlet

Single long-running test that exercises every README-claimed capability of Friday and saves a detailed report. Cannot be marked complete until the report is written **and** the completion gate passes.

## Run

Full gauntlet (~7.5 hours):

```bash
OPENAI_API_KEY=sk-... node tests-overnight/gauntlet.mjs
```

Fast smoke (~10 minutes — verifies all phase scripts wire up; does NOT fulfil the user's "real long-running" requirement):

```bash
FAST_MODE=1 OPENAI_API_KEY=sk-... node tests-overnight/gauntlet.mjs
```

Per-phase env knobs (full mode):

| env | default | meaning |
| --- | --- | --- |
| `PHASE_B_TURNS` | 120 | number of chat turns in long drift session |
| `PHASE_B_INTERVAL_MS` | 90000 | ms between turns |
| `PHASE_C_SESSIONS` | 10 | concurrent sessions |
| `PHASE_C_TURNS` | 20 | turns per concurrent session |
| `PHASE_W_WAIT_S` | 3650 | seconds to wait for token expiry |

## Output layout

```
/tmp/friday-overnight-test/
├── state/                          Friday isolated state (FRIDAY_STATE_DIR)
├── state-ui/                       Phase X (UI E2E) state
├── logs/
│   ├── orchestrator.log            top-level orchestrator log
│   ├── friday-server-3144.log      Friday server stdout/stderr
│   └── friday-ui-3145.log          Phase X server log
├── markers/                        per-phase {X}.complete.json
├── evidence/{X}/                   per-phase evidence artifacts
├── monitor-process.csv             RSS/VSZ over time
├── monitor-db.csv                  DB/WAL/heap over time
├── realtime-ws-events.jsonl        WS events captured for the entire run
├── captures/                       runner screenshots and non-product artifacts
├── fixtures/                       legacy runner fixtures only
└── STABILITY-FINDINGS-OVERNIGHT.md  the final report

Product-facing fixtures and requested output files are created inside the worktree:

```
.friday/overnight-gauntlet/
├── fixtures/                       generated fixtures that Friday may read
└── captures/                       files Friday may write during tool tests
```

This keeps the product workspace sandbox intact; the gauntlet no longer asks Friday
to read or write `/tmp` fixture paths.
```

## Completion gate

The orchestrator only prints `STABILITY GAUNTLET: COMPLETE` when:

1. All 27 expected phase markers (A,B,C1,C2,D1,D2,D3,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X) are present.
2. Every marker's `finishedAt > startedAt`.
3. Both Layer-1 monitor CSVs have ≥1 sample row.
4. The evidence sha256 (over the sorted concat of every phase's evidence-file hashes) is present in the report's last line as `<!-- gauntlet-evidence-sha256: ... -->`.

If any of those fail the orchestrator exits code 2 and the report header gets `# INCOMPLETE — see infrastructure-failure list`.

## Aborting

Send SIGINT or SIGTERM to the orchestrator; it does NOT trap them, so any phase already in flight is interrupted. Markers up to that point persist; you can re-run `node tests-overnight/lib/report.mjs` to regenerate the report from existing markers (with the INCOMPLETE banner if missing).

## Cost

Real OpenAI API calls. Estimated total: ~$2–4 on `gpt-4o-mini` for a full run.
