# Friday Public V1 Local Candidate

Last reviewed: 2026-05-19

This document summarizes the public v1 local candidate claim. It is a release
truth summary, not a universal product promise.

## Safe Claim

Friday is a local-first, BYOK AI agent application layer for supervised
automation. It can use configured providers, skills, workflows, memory, browser
or desktop control, and evidence-backed repair paths while keeping approval and
rollback boundaries visible.

## Current Proof Anchor

The public v1 local track is anchored by the Phase 18A-H and Phase 19 work on
`origin/main`, plus the dated capability ledger under `docs/audit/`.

The latest inspected GitHub Actions Real Green Gate run for the post-Phase-19
main SHA was:

- workflow: `Real Green Gate`
- run: `26097444351`
- artifact: `real-green-gate-26097444351` (`7083813494`)
- SHA: `1251a22003948a86d0fe8ea8edd849a9141e64aa`
- artifact result: `status=passed`, nonzero scenarios, all scenarios passing,
  and empty blockers

That artifact supports the public v1 local candidate wording for the local
track at that SHA. It does not supersede the repo-tracked capability matrix,
does not close any entry still recorded as `blocked_by_env`, and does not prove
optional external claims that were explicitly out of scope.

## In Scope For Public V1 Local

- local UI and local runtime
- BYOK setup and provider truth
- supervised operator workflows
- memory, learned facts, and user constitution surfaces
- approval-gated tool use
- evidence and rollback language
- candidate/staged skill and workflow lifecycle language
- public docs that do not overclaim channel, cloud, or release-complete-all

## Not Claimed

- unrestricted channel control or PR #244 channel live proof
- Alibaba/Tencent/Volcengine cloud live certification
- external OTEL/Grafana export
- Slack/SMTP external alert dispatch as release-complete
- default-on packaging or multi-tenant release proof
- full native desktop parity across every operating system
- generated or imported skills becoming immediately runnable without lifecycle gates
- every learned preference automatically changing future prompt behavior
- verified repair status from action counts alone
- Phase 18A live UI/LLM acknowledgement plus SSE tail, while it remains
  `blocked_by_env`
- release-complete-all

## Public Download Hygiene

Public release surfaces are split intentionally:

- npm package: the installable runtime artifact.
- GitHub source archive: the clean public source download.
- development repository: source, tests, and public docs for maintainers.

None of these surfaces should contain private local paths, local state, Desktop
operator control packages, release truth-map artifacts, dogfood/release-closure
folders, or real secrets. Development-only tests and historical audit files can remain in
the repository, but are excluded from GitHub source archives when they are not
needed for end-user download.

## Proof Rules

`blocked_by_env`, mock-only output, workflow success alone, missing artifacts,
stale artifacts, and wrong-SHA artifacts are not release proof.

Docs should say "configured", "candidate", "WIP", "blocked", or "future" when
that is the real state.
