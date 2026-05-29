# Friday Capability Matrix

This is the user-facing capability contract for the current Friday runtime.

Friday should never treat "a tool exists somewhere" as proof that a task can run. A capability is available only when the provider/tool/skill is configured, policy allows it, and a doctor or representative task verifies it.

## Status Vocabulary

| Status | Meaning |
| --- | --- |
| Available | Configured, policy-allowed, and verified |
| Provider-configured | Requires an external provider/account/API key and must be verified |
| Human blocker | Needs a user action such as login, OAuth, payment, CAPTCHA, API key, or permission |
| Needs review | Candidate exists but install/permission/sandbox approval is required |
| Deferred | Not part of the current supported runtime contract |

## Capability Matrix

| Capability | What Friday should do | Verification | Boundary |
| --- | --- | --- | --- |
| Text model | Route chat, planning, summarization, extraction, and generation to a configured model provider | provider doctor + representative text task | missing/invalid key is a human blocker |
| Vision / image understanding | Route image tasks to a configured multimodal provider | representative image task | depends on model/provider support |
| OCR | Use configured OCR provider or verified OCR skill | OCR sample task | account/API/permission setup may be external |
| Embeddings / memory search | Use embedding lane for semantic memory and retrieval where configured | embedding request + retrieval smoke | fallback search may be weaker and should be labeled |
| Web search | Use configured search provider such as Tavily, Serper, or custom skill | live search query | paid plan/quota/key issues are human blockers |
| PDF parsing | Parse local PDFs through built-in or verified parser | sample PDF extraction | scanned PDFs may require OCR |
| File read/write | Read/write local files when policy and scope allow | scoped file operation | sensitive paths and destructive writes require approval |
| Browser control | Open pages, inspect, click, type, screenshot, and gather evidence | local browser smoke | login/CAPTCHA/payment remain human blockers |
| Desktop control | Use OS companion for app/window/URL/notification actions | companion health + permission check | Accessibility/Screen Recording permissions require user |
| Skills | Generate, import, validate, install, run, update, delete, and verify skills | manifest + sandbox/dry-run + evidence | untrusted code needs review and policy approval |
| Workflows | Create, deploy, run, observe, recover, and roll back workflows | workflow run + evidence | production-impacting steps need approval |
| MCP servers | Discover tools/resources from configured MCP servers | connected/authenticated state + tool smoke | unauthenticated server is a structured blocker |
| Channels | Receive commands and send replies through configured channels | inbound/outbound channel smoke | channels cannot bypass approval gates |
| TTS / voice | Use configured TTS provider or local voice skill | representative speech task | provider account/key may be required |
| Memory | Store preferences, lessons, facts, routing signals, and run evidence | memory write/read smoke | user should be able to inspect and correct |
| Self-healing | Diagnose failures, propose fixes, auto-run low-risk repairs, verify, roll back, and pause on repeats | incident -> fix -> verification evidence | higher-risk repairs require approval |
| Capability acquisition | Find/generate/install/register missing capability candidates | acquisition run reaches verified state | install/download/shell/network actions are policy-gated |
| Standing goals | Run user-authorized agendas with evidence and learning updates | agenda run + result evidence | Friday does not invent unrelated long-term goals |

## Capability Acquisition Contract

New capability must move through:

```text
candidate -> plan -> sandbox/test -> approval if required -> install/register -> doctor verify -> available
```

Until doctor verification passes, the capability must not be routed as available.

Preferred source ranking:

1. already installed and trusted local capability
2. built-in catalog or verified marketplace/source
3. configured MCP server
4. local workspace skill/workflow
5. OpenAPI spec or package registry candidate
6. open web/GitHub discovery, if policy allows

## Human Blockers

Friday should stop and ask the user for:

- API keys and provider account setup
- OAuth and account login
- payment or billing enablement
- CAPTCHA or platform verification
- sensitive OS permissions
- production writes
- high-risk shell/file/browser/desktop actions
- untrusted package install approval

## What Friday Should Say When Blocked

A blocked capability should include:

- capability name
- exact blocker
- why Friday cannot do it alone
- where the user configures it
- what Friday will run to verify it afterward

Example:

```text
I do not have OCR yet. I need either an OCR-capable provider key or a verified OCR skill.
Configure it in Setup -> Capabilities -> OCR. After that I will run a sample image-to-text task and mark OCR available only if it passes.
```

## Capability Headlines (Boundary Summary)

The matrix above is the structured contract. The following three plain-language headlines summarize the current public `1.0.2` npm/runtime boundary and the unpublished GitHub-main `1.0.3` package-candidate source delta in operator-readable terms. They are the canonical wording the rest of the product surface (UI copy, release notes, docs) must align with:

Source-truth delta after the immutable npm `1.0.2` package: GitHub-visible main
has subsequently closed deterministic DP-10 personal-secretary loop proof
(PR #352), skill/link lifecycle proof (PR #353), repair/upgrade/retry-audit
proof (PR #354), and Memory cognition v1 proof (PR #355). Current source also
gates provider budget changes through canonical mutation approval in protected
profiles, repairs provider/cost/package source truth through PR #356/#357/#358,
closes Home supervised low-risk self-repair UI proof by PR #359, and closes
user-visible workflow retry receipt/final-state proof by PR #360. Later source
also closes C2.4 parent-runtime natural-trigger source repair by PR #377, C3/C4
live-provider routing proof by PR #378, and C4.5 direct synthetic real-user
intelligence proof by PR #379. PR #380 prepares the unpublished `1.0.3` package
candidate on GitHub main without npm publish, tag, or GitHub release. GitHub main
further closes the strict-repair batch through PR #412: the B6 dangerous-command
shell-risk gate (PR #396/#397/#399/#402); workflow completion-truth for the
deterministic core / filesystem-write — with the non-filesystem side-effect
classes (send / connect / capture / execute / memory.write) remaining
`proof_pending` by design (PR #398/#407); receipt / idempotency / usage-ledger
truth (PR #401/#403/#408); and truth-label corrections (PR #405/#406/#411). An
isolated, operator-authorized local DeepSeek competence proof additionally
achieved a clean `verified_receipt` for the local read → reason → canonical
approval-gated write → oracle-verified-artifact loop, DeepSeek-only — a single
bounded local proof, not a claim of 100% all-mechanisms-live, all-integrations-
live, latest-SHA live external-channel delivery, or broad live-provider quality.
Package/npm truth stays separate. Do not read these source closures as already
published npm `1.0.2` behavior or as a published `1.0.3` release.

### What Friday Can Do Today

In `1.0.2`, Friday can run the local-first runtime described in the matrix above: configured chat and task execution, BYOK provider routing for text / vision / OCR / embeddings / web search where the lane is provider-configured and verified, PDF and file work inside scoped paths, browser/desktop control inside the operator-approved boundary, MCP server discovery against connected servers, skill and workflow lifecycle through the candidate → sandbox → approval → register → doctor-verify path, supervised self-healing with bounded auto-fix and rollback, configured trusted-channel inbound on Discord/Telegram/Lark+Feishu (proven on the `1.0.2` release SHA via same-SHA Real Green Gate channel artifacts), memory and learned-preference surfaces, and operator-visible audit/evidence/observability. "Today" means available in the released runtime; "should be able to" is not the same as "today" and stays in the matrix or roadmap.

### What Friday Usually Does Only Under Supervision

In `1.0.2`, the following surfaces exist but **usually run only under supervision** — they are wired with fail-closed approval gates and operator review, not as default-on autonomous behavior. The user, operator, or canonical approval flow is in the loop for: skill install / update / delete (canonical-approval workflow), autonomous self-repair lifecycle (the lifecycle is visible; end-to-end execute → rollback is supervised and `proof_pending` for autonomy-detected incidents), autonomous self-upgrade proposals (visible; actual mutation supervised and `proof_pending`), link-to-skill candidate → tests → approval → run (scan-local works; URL trust bypass is fail-closed; end-to-end run is supervised and `proof_pending`), queue/retry retry-eligible execution, audit-log replay, dispatcher-style auto-fix (default-off behind `FRIDAY_AUTOFIX_DISPATCHER_ENABLED`), and channel actions with sensitivity. GitHub main after `1.0.2` additionally proves user-visible workflow retry receipts by PR #360, but that is not npm `1.0.2` package truth. Anything else that is irreversible, account-bound, payment-related, CAPTCHA-gated, or production-impacting follows the same supervision-by-default rule even when not explicitly listed here.

### What Friday does **not** reliably claim today

In `1.0.2`, Friday explicitly does **not** reliably claim: desktop / Homebrew / notarized macOS / mobile distribution; outbound channel-control automation beyond configured trusted-user inbound on Discord/Telegram/Lark+Feishu; Slack HTTP Events-API inbound and QQ (both permanently `unsupported`); Alibaba/Tencent/Volcengine cloud live certification; external OTEL/Grafana export; Slack/SMTP external alert dispatch as release-complete; default-on packaging or multi-tenant release proof; full native desktop parity across every operating system; "all integrations live"; release-complete-all; completed autonomous self-repair / self-upgrade / skill-mutation / link-to-skill end-to-end runs (all `proof_pending` per dogfood closure); trusted-device passkey remote access; a real fleet control plane; deeper fleet-triggered remediation beyond satellite degradation/offline ingestion, cooldown sweep, and operator loop visibility; or unrestricted autonomy beyond the supervised self-healing surface. Capabilities not on this list are not by that omission "claimed"; see the matrix above for the structured contract.

## Related References

- [Current Source Of Truth](../current-source-of-truth.md)
- [Vision](../VISION.md)
- [Getting Started](../getting-started.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
