# Friday Blueprint: Closed-Loop Usability

This blueprint defines the product loop Friday should close for ordinary users.

The target is not "fully automatic everything." The target is:

```text
user goal -> capability check -> gap closure -> execution -> verification -> learning -> clear next step
```

When a human is required, Friday should say exactly why and what to do next.

## Loop 1: Install -> Open Home

Expected path:

1. Install Friday.
2. Start the local runtime.
3. Open `http://localhost:3141`.
4. Complete setup.
5. Reopen Friday and land on Home.

Exit criteria:

- `/v1/health` returns ok.
- setup status is available.
- completed setup users do not see the recovery/auth/setup gate unnecessarily.
- provider truth reflects the actual live route.

## Loop 2: Goal -> Capability Check

When the user asks for a task, Friday should identify required capabilities:

- text model
- vision / image understanding
- OCR
- embeddings / memory search
- web search
- PDF parsing
- file read/write
- browser or desktop control
- skills/workflows
- MCP tools
- channels
- TTS / voice

Exit criteria:

- Friday can answer "Do I have this capability?"
- Friday can answer "What is missing?"
- Friday can answer "Where do I configure it?"
- Friday can answer "How will I verify it?"

## Loop 3: Missing Capability -> Acquisition

When capability is missing, Friday should run:

```text
candidate -> plan -> sandbox/test -> approval if required -> install/register -> doctor verify -> available
```

Allowed low-risk actions:

- search existing local capabilities
- inspect trusted catalogs
- generate a draft skill/workflow
- run sandbox verification
- produce a setup plan

Human-gated actions:

- API key entry
- OAuth/login
- payment/billing
- CAPTCHA
- sensitive OS permissions
- external account access
- production writes
- untrusted installs

Exit criteria:

- unverified capability is not routed as available
- failed acquisition leaves evidence and rollback
- human blocker is explicit

## Loop 4: Execute -> Verify -> Report

Friday should execute only after capability and policy are satisfied.

Exit criteria:

- task plan is visible
- progress updates are concise
- tool/workflow evidence is recorded
- result is verified against the task goal
- failure includes cause, blocker, and next step

## Loop 5: Learn -> Improve

Friday should improve through auditable state, not hidden model training.

Allowed learning outputs:

- memory facts
- provider routing preferences
- setup recipes
- generated skill/workflow quality signals
- eval cases
- failure lessons
- capability source ranking

Exit criteria:

- user can inspect or correct meaningful learned facts
- safety policy is not weakened by learning
- failures become regression cases when practical

## Loop 6: Standing Goals -> Agenda

For user-authorized long-term goals:

1. Create standing goal with scope, trigger, risk policy, budget, and success criteria.
2. Generate agenda items.
3. Check capability and policy.
4. Execute low-risk work automatically if authorized.
5. Pause for high-risk or human-only steps.
6. Report evidence, cost, verification, and learning update.

Exit criteria:

- no standing goal runs without user authorization
- user can pause/delete goals
- agenda runs include evidence and rollback/failure notes

## Project Definition Of Done

Friday is closed-loop usable when it can reliably answer and act on:

- what it can do
- what it cannot do yet
- what is missing
- where the user configures it
- how it verifies configuration
- whether the task actually completed
- what it learned or changed afterward

## Related Docs

- [Getting Started](getting-started.md)
- [Capability Matrix](ops/friday-capability-matrix.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Vision](VISION.md)
