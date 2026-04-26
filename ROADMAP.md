# Friday Roadmap

Friday's roadmap is organized around one product promise:

```text
You give a goal. Friday checks capability, closes gaps where allowed, executes, verifies, and learns.
```

It should feel capable and proactive, but not uncontrolled. Friday does not promise universal automation or fully automatic behavior across every external system.

## Current Focus

- Setup should be understandable and recoverable.
- Completed setup should open directly to Home.
- Provider truth should show the actual live route.
- Capability status should be explicit: available, missing, human blocker, needs review, or deferred.
- Generated/imported skills should not become available until verification passes.
- Channels can control Friday, but high-risk actions still require confirmation.
- Memory and self-improvement should be visible, auditable, and reversible.

## Near-Term Work

### Capability Self-Acquisition

Friday should move missing capabilities through:

```text
goal -> gap -> candidates -> sandbox/test -> approval -> install/register -> doctor verify -> execute
```

Human-only blockers remain API keys, OAuth, payment, CAPTCHA, account setup, sensitive permissions, and production-impacting actions.

### Standing Goals And Agenda

Friday should support user-authorized long-term goals:

- scope
- triggers
- budget
- risk policy
- success criteria
- pause/delete controls
- evidence and learning after each run

### Real Capability Verification

Representative tasks should verify:

- text model
- vision
- OCR
- embeddings
- web search
- PDF
- file read/write
- browser
- desktop companion
- MCP
- skills
- workflows
- channels
- memory
- TTS where configured

## Later

- More provider setup recipes.
- More channel setup wizards.
- More visible self-healing and rollback UX.
- Better memory inspection and correction.
- More visual evidence for browser and desktop runs.
- Stronger sandboxing and dependency isolation for generated capabilities.
- Cross-device and packaged desktop distribution polish.

## Not The Roadmap

- No promise that Friday can do every task alone.
- No bypassing account login, CAPTCHA, payment, provider limits, or platform rules.
- No hidden training of model weights by default.
- No high-risk action without approval.
- No treating missing external credentials as success.

See also:

- [Vision](docs/VISION.md)
- [Capability Matrix](docs/ops/friday-capability-matrix.md)
- [Closed-Loop Blueprint](docs/BLUEPRINT-CLOSED-LOOP.md)
