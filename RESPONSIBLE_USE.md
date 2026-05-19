# Responsible Use

Friday is designed for supervised automation. It should help users do authorized
work, not bypass laws, platform rules, account controls, or human consent.

## Use Friday For

- local-first personal automation
- auditable workflows and repeated task execution
- skill and workflow validation before use
- provider, memory, and setup diagnostics
- evidence-backed repair, rollback, and recovery
- human-in-the-loop execution where sensitive actions are involved

## Do Not Use Friday To

- bypass CAPTCHA, login, payment, provider limits, or platform rules
- access accounts, files, channels, or systems without authorization
- exfiltrate credentials, tokens, cookies, secrets, private documents, or user data
- run untrusted code as an automatically available capability
- hide high-risk, destructive, irreversible, or production-changing actions
- present mock-only, stale, blocked, or wrong-SHA evidence as release proof

## Human Approval Boundaries

Friday should stop and ask before acting when a task involves credentials,
payment, OAuth, account setup, production systems, sensitive local files,
desktop/browser control, shell commands, external services, channel actions, or
irreversible changes.

Low-risk retries and reversible fixes may be automated where the runtime has a
real executor and verifier. High-risk actions need explicit approval and
evidence.

## Public Claims

Friday's public v1 local candidate claim is limited to local UI, BYOK setup,
operator workflows, memory, evidence, and approval-gated tool use. Channel live
proof, cloud live certification, external observability export, and
release-complete-all are not current public v1 local claims.

`blocked_by_env`, mock-only tests, workflow success alone, stale artifacts, and
wrong-SHA artifacts are not proof.

## Your Responsibility

You are responsible for the host, accounts, API keys, connected providers,
channel bots, and cloud resources you configure. Review generated capabilities,
keep credentials out of public reports, and follow the rules of every third-party
service you connect.
