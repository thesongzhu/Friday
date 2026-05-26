# Friday Public V1 Local Candidate

Last reviewed: 2026-05-26

This document summarizes the public v1 local candidate claim for the published
`1.0.x` local-candidate line. The current public npm/source release is `1.0.2`.
It is
a release truth summary, not a universal product promise. Distribution mode is
**npm/source only**.

## Safe Claim

Friday is a local-first, BYOK AI agent application layer for supervised
automation. It can use configured providers, skills, workflows, memory, browser
or desktop control, and evidence-backed repair paths while keeping approval and
rollback boundaries visible. Configured trusted-channel inbound for Discord,
Telegram, and Lark/Feishu is proven via same-SHA Real Green Gate channel
artifacts on the release SHA.

## Current Proof Anchor

The public v1 local track for every published `1.0.x` release is anchored by
**same-SHA Real Green Gate proof on the final release SHA**, captured via
GitHub Actions and operator-controlled evidence storage outside the public
source tree.

### Release rule (must hold for every published release)

A published release requires same-SHA R5 proof on its final release SHA
covering all of the following:

- **Scenario lane**: Real Green Gate `real-green-gate-result.json` with
  `status=passed`, `blocked_reasons=[]`, and `evidence_kinds_observed`
  including `real-runtime`, `real-provider`, `real-browser`, and
  `manual-external`.
- **Trusted-inbound channel artifacts**: all three `phase24b` (Discord),
  `phase24c` (Telegram), and `phase24d` (Lark/Feishu) listener artifacts
  with `status=passed`, `failures=[]`, and
  `environment.commit_sha` matching the release SHA.
- **Validator check**:
  `scripts/ops/validate-channel-proof-artifacts.mjs --expected-sha
  <release-sha>` reports `valid:true, blockerClass:none, reasons:[]` for
  every channel.

### Where to find the concrete proof for a specific release

The concrete run ids, release SHA, and artifact paths for any published
`1.0.x` release are recorded in the public release surfaces:

- the **GitHub release notes** for the `v1.0.x` tag at
  [github.com/thesongzhu/Friday/releases](https://github.com/thesongzhu/Friday/releases);
- the **release manifest** emitted by `.github/workflows/release.yml`
  during publish (source-only mode) and attached to the GitHub release.

Operator-controlled evidence storage holds the per-release proof receipts
in private form for the maintainer; that storage is intentionally not in
the public source tree.

Run ids and release SHAs are deliberately not hardcoded in this tracked
document, so that release-hygiene doc updates do not require a follow-up
doc patch for every new release SHA.

### Scope of the same-SHA proof

The same-SHA R5 proof above is the authoritative release gate. It supports
the public v1 local candidate wording for the local track and the
configured trusted-inbound channel track at the release SHA. It does not
supersede the repo-tracked capability matrix, does not close any entry
still recorded as `blocked_by_env`, and does not prove optional external
claims that were explicitly out of scope.

The dogfood runtime evidence baseline was captured during the `1.0.1` release
closure under an 8-hour soak run; the soak SHA, run id, and report paths are recorded in
operator-controlled evidence and referenced from the release-closure plan.
When the runtime delta from the soak SHA to the published release SHA is
zero, the soak evidence is transferable; this is verified per release in
the release-closure plan's runtime-delta classification report.

## In Scope For Public V1 Local

- local UI and local runtime
- BYOK setup and provider truth
- supervised operator workflows
- memory, learned facts, and user constitution surfaces
- approval-gated tool use
- evidence and rollback language
- candidate/staged skill and workflow lifecycle language
- configured trusted-channel inbound for Discord, Telegram, and Lark/Feishu
  with same-SHA Real Green Gate channel-artifact proof on the release SHA
- public docs that do not overclaim outbound channel control, cloud, or
  release-complete-all

## Not Claimed

- outbound channel-control automation (Discord/Telegram/Lark/Feishu inbound
  trusted-user receipt is proven; full bidirectional channel control is not
  claimed)
- Slack HTTP Events-API inbound (permanently `unsupported` in the public
  `1.0.x` local-candidate line)
- QQ (permanently `unsupported` in the public `1.0.x` local-candidate line)
- Alibaba/Tencent/Volcengine cloud live certification
- external OTEL/Grafana export
- Slack/SMTP external alert dispatch as release-complete
- default-on packaging or multi-tenant release proof
- full native desktop parity across every operating system
- desktop, Homebrew, notarized macOS, or mobile distribution in `1.0.2`
- generated or imported skills becoming immediately runnable without lifecycle gates
- every learned preference automatically changing future prompt behavior
- verified repair status from action counts alone
- Phase 18A live UI/LLM acknowledgement plus SSE tail, while it remains
  `blocked_by_env`
- "all integrations live"
- release-complete-all

## Dogfood Closure And Proof-Pending Headlines

The dogfood gate for `1.0.1` closed as `dogfood_partial_pass` with weighted UX
score 7.78/10 (below the 8.0 `dogfood_pass` threshold), and these headlines
remain carried forward in `1.0.2`. The following
capabilities are wired with fail-closed lifecycle gates but end-to-end execution
is `proof_pending` and explicitly carried forward for a subsequent dogfood pass:

1. Autonomous self-repair end-to-end execute → rollback (lifecycle exists; no
   autonomy-detected runtime incident occurred during the dogfood test instance)
2. Autonomous self-upgrade actual mutation (lifecycle visible; no proposal
   triggered during the test instance)
3. Skill install / update / delete through the canonical-approval workflow
   (gates fail-closed at `SKILL_LEGACY_LIFECYCLE_ROUTE_RETIRED`,
   `SKILL_LIFECYCLE_UPDATE_APPROVAL_REQUIRED`,
   `SKILL_LIFECYCLE_DELETE_APPROVAL_REQUIRED`; canonical-approval flow setup
   remains out of scope for the current dogfood evidence)
4. End-to-end link-to-skill candidate → tests → approval → run (scan-local
   works; install gate prevents URL trust bypass; full end-to-end run is
   carried forward)
5. Queue/retry end-to-end receipt loop with a retry-eligible incident (read
   endpoints work; no retry-eligible incident was triggered)
6. Audit tamper-negative on a disposable test ledger (read endpoints work;
   tamper-negative round-trip carried forward)
7. R1 Lark phase24d listener-shutdown bug (listener writes `status=passed`
   correctly but the WebSocket holds the event loop open; non-correctness;
   artifact is durable; roadmap follow-up)
8. Speed/cost end-to-end `near_limit` / `over_limit` UI surfacing (primitives
   wired; full flow not exercised end-to-end)
9. Memory per-item `confidence` and `last_accessed` field surfacing (ranking,
   score, and access-count work; per-item `confidence` not yet surfaced in the
   API shape)

These are truth-labeled, not silent passes. None contradict the safe claim
above.

## Public Download Hygiene

Public release surfaces are split intentionally:

- npm package: the installable runtime artifact.
- GitHub source archive: the clean public source download.
- development repository: source, tests, and public docs for maintainers.

None of these surfaces should contain private local paths, local state, Desktop
operator control packages, release truth-map artifacts, dogfood/release-closure
folders, internal audit/report archives, or real secrets. Development-only tests
can remain in the public repository for maintainers, but are excluded from GitHub
source archives when they are not needed for end-user download.

## Proof Rules

`blocked_by_env`, mock-only output, workflow success alone, missing artifacts,
stale artifacts, and wrong-SHA artifacts are not release proof.

Docs should say "configured", "candidate", "WIP", "blocked", or "future" when
that is the real state.
