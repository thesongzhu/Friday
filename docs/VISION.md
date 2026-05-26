# Friday Vision

Friday's long-term direction is a controlled, local-first personal AI that can help ordinary users get real work done without forcing them to become toolchain operators.

The product should feel ambitious, but the contract must stay honest:

- Friday can pursue user-given goals inside configured capability, policy, budget, and safety boundaries.
- Friday can find or generate skills when it lacks a capability, but new capability must pass verification before it becomes routable.
- Friday can improve itself through memory, recipes, routing preferences, evals, skills, workflows, and failure lessons.
- Friday does not train model weights by default and does not invent unrelated long-term goals.
- Friday does not bypass accounts, payment, CAPTCHA, platform rules, or human approval.

## North Star

The user says what they want. Friday handles the operational work around it:

```text
goal -> capability check -> gap closure -> execution -> verification -> memory/improvement
```

The user should not need to know whether a task requires text generation, image understanding, OCR, embeddings, web search, PDF parsing, browser control, a channel adapter, an MCP server, or a generated skill. Friday should know how to check, route, configure, or ask for help.

## Current Product Truth

Friday is a supervised personal automation system with a growing local runtime:

- chat and task execution surfaces
- setup and provider routing health
- capability matrix and provider doctor checks
- skills lifecycle: generation, import, validation, install, verify, update, delete
- workflow creation, execution, evidence, recovery, and rollback
- memory, learned preferences, and self-learning context
- self-healing incidents, diagnosis, auto-fix, approval, verification, and pause-on-repeat-failure behavior
- browser, desktop, file, PDF, MCP, and channel surfaces where configured
- multi-channel control with human gates for sensitive actions
- local runtime observability through traces, audit, health, alerts, and evidence

This does not mean every capability is available out of the box. Provider-backed lanes need valid credentials. External accounts need human setup. New tools need verification.

## Two Closure Loops

### 1. Capability Self-Acquisition

When a user goal requires a missing capability, Friday should run a controlled acquisition loop:

1. detect required capabilities
2. compare against the runtime capability matrix
3. search installed/trusted sources first
4. search open sources only when policy allows
5. generate or select candidates
6. sandbox and test
7. request approval when risk requires it
8. install/register
9. run doctor verification
10. mark available only after verification
11. execute the original task

Human blockers include account creation, OAuth, payment, CAPTCHA, API keys, sensitive permissions, and production-impacting actions.

### 2. Long-Term Goals And Self-Improvement

Friday may work on standing goals only when the user authorizes them.

A standing goal should include scope, triggers, risk policy, budget, success criteria, and pause/delete controls. Agenda runs should include plan, capability check, evidence, cost, verification, failure handling, rollback, and learning update.

Self-improvement should update:

- memory facts
- provider routing preferences
- setup recipes
- generated skill/workflow quality signals
- eval cases
- failure lessons
- capability-source ranking

It should not silently train model weights or hide changes from the user.

## Safety Boundary

Friday should automate low-risk, reversible, verifiable work. It should stop and ask when work becomes sensitive, irreversible, expensive, account-bound, or production-impacting.

Required safety properties:

- user-visible capability state
- explicit human blockers
- approval gates for high-risk actions
- scoped capability grants with expiry
- audit evidence for sensitive tool use
- rollback for installs and repairs
- no secret leakage into docs, logs, screenshots, or public issues
- no route that treats missing external credentials as success

## What Friday Is And Is Not (Boundary And Not Claimed)

Friday's current product truth is a **supervised, bounded automation system**: capabilities run inside configured boundaries, sensitive or high-risk steps go through human approval, and self-improvement is auditable and reversible. The following items are explicitly **not** claimed in `1.0.1` and must not be implied by docs, UI copy, or release notes:

- Friday is not an **unrestricted autonomous agent loop beyond the supervised self-healing surface**. The active autonomy lane is the supervised self-healing surface (incident → diagnosis → bounded auto-fix → verification → rollback / pause-on-repeat-failure). Open-ended autonomous task decomposition or goal invention is not part of the released runtime; end-to-end autonomy proof is `proof_pending`.
- Friday does not claim trusted-device passkey remote access in `1.0.1`. The current authentication surfaces are local bootstrap, local passphrase, and operator session tokens; remote passkey-bound device trust is `not_in_this_release`.
- Friday does not ship a real fleet control plane in `1.0.1`. Current fleet primitives are limited to satellite registration, capability advertisement, distributed execution dispatch with hub-side routing, the offline sweeper, and operator-visible loop state; a full multi-tenant fleet control plane (orchestration, policy distribution, identity federation, rolling updates) is `not_in_this_release`.
- Friday does not provide deeper fleet-triggered remediation beyond the current satellite degradation/offline ingestion, cooldown sweep, and operator loop visibility in `1.0.1`. Fleet-side remediation today is bounded to those primitives; broader fleet-coordinated repair, scale-up/down, and cross-satellite policy enforcement are out of scope for `1.0.1`.

These boundary statements align with the `1.0.1` dogfood closure (`dogfood_partial_pass`), which carried forward an explicit list of `proof_pending` headlines including autonomous self-repair end-to-end execute → rollback, autonomous self-upgrade actual mutation, skill install/update/delete canonical-approval workflow, and end-to-end link-to-skill candidate → run.

## Product Tone

Friday should sound like a calm private execution assistant:

- clear before clever
- short progress updates during work
- no fake certainty
- no generic chatbot filler
- direct failure language
- exact missing capability or human blocker
- action-oriented next step

The voice can feel human, but it should not bury technical truth.

## Roadmap Shape

Near-term focus:

1. Make setup and capability truth obvious.
2. Make provider/channel configuration verifiable.
3. Make capability acquisition a first-class runtime loop.
4. Make standing goals and agenda runs inspectable.
5. Make memory and self-improvement visible and editable.
6. Keep autonomy policy, audit, rollback, and safety boundaries hard to bypass.

See [Roadmap](../ROADMAP.md) and [Capability Matrix](ops/friday-capability-matrix.md).
