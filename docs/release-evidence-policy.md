# Friday Release Evidence Policy

This document defines what Friday may count as release proof.

## Core Rule

Only evidence produced by **real provider**, **real browser**, **real runtime**, **cloud live**, or **manual external** lanes may support a ship decision.

Anything classified as `mock-contract`, `mock-hub`, or `browser-mock-hub` may still be useful for fast regression detection, but it is **not** release proof.

## Evidence Kinds

| Evidence kind | Uses mock | Release-proof eligible | Typical examples |
| --- | --- | --- | --- |
| `mock-contract` | Yes | No | unit tests, type checks, route contract tests, deterministic repo guards |
| `mock-hub` | Yes | No | hub/runtime flows driven by mock providers or mock hub env |
| `browser-mock-hub` | Yes | No | browser automation using `createMockHubEnv`, seeded `localStorage`, or fake transports |
| `real-provider` | No | Yes | live Anthropic/OpenAI/Ollama provider calls, live routing/failover, live auth errors |
| `real-browser` | No | Yes | browser walkthroughs against a live Friday runtime with no seeded state |
| `real-runtime` | No | Yes | live hub + HTTP server + auth + route + persistence checks |
| `cloud-live` | No | Yes | checks against a deployed Friday environment |
| `manual-external` | No | Yes | Reddit parity review, external channel/manual env validation, third-party walkthroughs |

## Script Semantics

- `npm run release:verify:repo` means **repo-ready verification**, not ship proof.
- `npm run release:verify` means **live release proof** only. It must not route through repo-only mock lanes.
- `npm run release:proof:real` is the explicit live-proof entry point and currently aliases the same real proof pack as `release:verify`.

## Commit And Release Truth Rules

- Do not describe documentation edits, comment edits, packaging work, or new feature scope as "fixed X bugs" unless a real defect ledger entry exists.
- Do not cite total test counts without the evidence kind and whether those counts are release-proof eligible.
- Do not claim a surface is "supported" when it is env-gated, operator-only, empty by default, or blocked on machine permissions unless that boundary is explicit in the copy.
- When a live lane is blocked by environment, mark it `blocked-by-env`; never silently treat it as pass.

## Required Release Inputs

Every ship decision should have:

1. A current runtime snapshot.
2. A claim matrix that compares README/UI/docs claims against live evidence.
3. A defect ledger with reproduction, root cause, release impact, and verification method.
4. A no-mock contamination check over the proof inputs.
5. A final verdict: `shipable as-is`, `shipable with explicit de-scope`, or `not shipable`.
