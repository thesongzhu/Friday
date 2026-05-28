# Friday Public V1 Local Candidate

Last reviewed: 2026-05-28

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
- default-on packaging or multi-tenant availability; current source has a deterministic env-gated package/multi-tenant proof harness, but npm `1.0.2`, default-on flips, and production multi-tenant rollout remain not claimed
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
score 7.78/10 (below the 8.0 `dogfood_pass` threshold). The published npm
`1.0.2` package still carries the original proof-pending headlines. GitHub-visible
source after `1.0.2` has narrowed several of them with PR #350 through PR #360,
then added Phase24E/F/G workflow-candidate approve/reject live proofs for
Telegram, Discord, and Lark/Feishu. Those source changes are **not** npm package
truth until a future authorized publish, and Phase24H natural-trigger execution
remains paused / `proof_pending`. Current source truth:

1. Autonomous self-repair execute → rollback: deterministic skill-drift and
   route rollback receipt mechanics are closed on GitHub main by PR #351 and
   PR #354. Live-provider and UI/channel repair dogfood remain separate.
2. Autonomous self-upgrade actual mutation: workflow lifecycle shadow/canary/
   promote/rollback now requires canonical mutation approval by PR #354. A
   product-discovered live mutation remains separate.
3. Skill install / update / delete through canonical approval: deterministic
   import/stage, promote/run, update, rollback, and Review Center candidate
   boundaries are closed on GitHub main by PR #353. Live external-channel and
   npm package truth remain separate.
4. Link-to-skill candidate → tests → approval → run: controlled link staging,
   evidence extraction, private/local URL denial, restart run, and rollback
   cleanup are closed on GitHub main by PR #353. Arbitrary live-web/channel
   proof and npm package truth remain separate.
5. Queue/retry receipt loop: deterministic retry-to-audit append is closed on
   GitHub main by PR #354, and user-visible workflow retry receipt/final-state
   proof is closed on GitHub main by PR #360. npm package truth and live
   external-channel/provider retry proof remain separate.
6. Audit tamper-negative: disposable retry/audit tamper detection is closed on
   GitHub main by PR #354. Broader user-visible audit UX can be proven later.
7. R1 Lark phase24d listener shutdown: source cleanup is closed on GitHub main
   by PR #350. npm `1.0.2` does not contain it.
8. Speed/cost `near_limit` / `over_limit`: current source routes expose live
   budget/usage/provider-health data, the Usage page has explicit near-limit
   and over-limit labels, and provider budget writes require canonical mutation
   approval in gate-required profiles. Provider/cost dashboard polish and npm
   package truth remain separate.
9. Memory cognition v1: guarded recall, ranking, PII redaction, non-destructive
   sync, restart/recovery, and duplicate-row non-merge proof are closed on
   GitHub main by PR #355. Destructive dedup merge/block policy, live external
   memory dogfood, and npm package truth remain separate.

10. Channel workflow-candidate approve/reject: Telegram (Phase24E), Discord
    (Phase24F), and Lark/Feishu (Phase24G) live artifacts now validate on
    GitHub main after `1.0.2`, with reject not saving a workflow and approve
    saving through real CRUD. These proofs intentionally use a stubbed LLM
    bridge and remain separate from npm package truth, live LLM generation,
    outbound channel automation, and natural-trigger execution.
11. Phase24H Telegram natural-trigger execution: source and repair attempts are
    present on GitHub main, but the live proof is paused / `proof_pending`.
    Do not claim that a live LLM autonomously invoked mutating `workflow_run`.
    The unresolved design question is whether this proof should require live
    LLM tool autonomy or parent-runtime deterministic workflow execution after
    a trusted natural trigger.

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
