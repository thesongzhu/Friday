# Friday Trust Model

Friday's trust model is simple: an AI agent should not become more powerful than
the user's verified setup, explicit approvals, and available rollback path.

## Current Public Posture

Friday is a **public v1 local candidate**. That means the current public-facing
claim is local-first, BYOK, supervised automation through the local UI and local
runtime.

It does not mean every optional integration in the repository is release-complete.
Channels, cloud live certification, external OTEL/Grafana export, and
release-complete-all remain future or configured-only claims until they have real
same-SHA proof.

## What Friday Tries To Guarantee

- **Capability truth:** missing provider keys, accounts, OAuth, CAPTCHA,
  payment, and permissions are blockers, not success.
- **Approval boundaries:** high-risk and sensitive actions require approval.
- **Evidence:** tool calls, workflows, self-healing runs, and channel actions
  should leave audit evidence; action counts are not the same thing as verified
  repair counts.
- **Rollback:** generated, installed, or repaired capabilities should not be
  called verified repairs unless there is a rollback path or an explicit
  non-reversible receipt.
- **Memory separation:** explicit preferences, learned facts, runtime evidence,
  and audit records are separate surfaces.
- **No hidden model training:** Friday stores auditable state and reusable
  artifacts; it does not silently train model weights by default.

## What Friday Does Not Guarantee

- universal automation across every external system
- autonomous account creation, payment, login, or CAPTCHA bypass
- safe execution of arbitrary third-party code without review
- instant availability of generated or imported skills before candidate,
  shadow/canary, and promotion gates pass
- universal prompt influence from every learned preference
- complete native desktop parity across every operating system
- channel or cloud live proof when credentials and test environments are absent
- release proof from mock-only tests, blocked environments, stale artifacts, or
  wrong-SHA artifacts

## Evidence Levels

Friday uses evidence tiers. Fast local tests and mock tests are useful for
regression detection, but public release proof requires real provider, browser,
runtime, cloud, or manual-external evidence where the claim depends on those
systems.

Real Green Gate output is release-proof eligible only when it is for the same
commit SHA, runs nonzero scenarios, passes every scenario, and reports no
blockers.

## Open Source Trust

Friday is open source under the MIT license. Security issues should be reported
through GitHub Security Advisories or the path in `.github/SECURITY.md`.

Public docs should stay honest about what is wired, what is partial, what is
blocked by environment, and what is future work. If README, roadmap, or a report
conflicts with the runtime source of truth, prefer `docs/current-source-of-truth.md`
and the current code.
