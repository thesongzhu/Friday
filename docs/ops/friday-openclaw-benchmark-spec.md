# Friday vs OpenClaw Benchmark Spec

## Goal

This benchmark exists to answer a user-facing product question with evidence:

- where Friday and OpenClaw produce equivalent real-task outcomes
- where they differ
- whether a difference is an ability gap, a bounded-product choice, or evaluation noise

This benchmark does not try to prove abstract architectural parity. It measures task results.

## Systems Under Test

- Friday `main`
- OpenClaw local reproducible baseline

## Round 1 Scope

Round 1 is a mixed-case benchmark across three scenario families:

- dialog and clarification
- doing work and pushing tasks forward
- troubleshooting, fixing, verifying, and pausing

The first pass uses 12 total cases:

- 4 dialog cases
- 4 doing-work cases
- 4 troubleshooting cases

Each case records:

- initial context
- tool boundary
- expected evidence
- failure class
- whether the case is inside Friday's canonical boundary
- whether the case is inside the explicitly tracked OpenClaw overlap scope
- whether the case is deferred by design

## Scoring

Every result includes:

- task completion
- clarification quality
- repair effectiveness
- verification and rollback completeness
- tool-use realism
- risk control
- user friction
- duration and step count where available

Verdicts are reported as:

- `Equivalent`
- `Weaker but acceptable`
- `Gap`
- `Boundary by design`

Gap attribution uses:

- ability gap
- strategy too conservative
- strategy too aggressive
- product boundary difference
- evaluation noise or instability

## What Round 1 Does Not Claim

Round 1 does not claim:

- full behavioral identity between Friday and OpenClaw
- unrestricted autonomy parity
- parity outside the current overlap scope
- platform rollout parity

## Evidence

Artifacts are written under:

- `.friday/evidence/openclaw-mixed-round1`

Each benchmark run archives:

- structured JSON results
- a markdown summary
- per-case sandbox outputs
- final verdict totals

## Current Interpretation Rule

If a case lands outside Friday's current canonical product boundary, the benchmark should label it as `Boundary by design`, not as a hidden bug.
