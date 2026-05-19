# Friday Privacy

Friday is local-first. The default product shape is that your runtime, state,
memory, evidence, and credentials live on machines or cloud accounts you control.
Friday does not operate a hosted user-data service for this repository.

## What Friday Stores Locally

Depending on what you enable, Friday may store:

- setup state, provider configuration, and capability status
- conversations, task runs, workflow runs, audit logs, and evidence summaries
- memory items, learned facts, explicit preferences, and recovery lessons
- skill, workflow, plugin, MCP, channel, satellite, and provider metadata
- rollback pointers, incident records, diagnostics, and verification results

Friday separates memory, explicit preferences, learned candidates, runtime
evidence, and audit records. Learned signals are not hidden model training and
should not be treated as unquestioned truth.

## Credentials And Secrets

Friday is BYOK. API keys, OAuth tokens, channel credentials, provider secrets,
and cloud credentials should be stored as environment variables, managed secret
refs, files you control, or OS-backed secret storage.

Friday docs and reports should never include raw API keys, bearer tokens,
cookies, passphrases, private keys, or secret fragments. Secret-like values in
tests and fixtures must stay synthetic and clearly non-production.

## Third-Party Providers

When you connect a model, search, OCR, browser, channel, MCP, or other external
provider, the data needed for that request may be sent to that provider. Friday
cannot make third-party providers private; it can only make the route visible,
approval-gated where needed, and auditable.

If a task requires account login, payment, CAPTCHA, OAuth, API keys, sensitive
permissions, or production-impacting action, Friday should treat that as a human
blocker instead of silent success.

## Logs, Evidence, And Telemetry

Friday records audit and evidence so users can understand what happened. Tool
summaries should record privacy-safe metadata such as tool names, argument keys,
result shape, status, and errors, not secret values.

External telemetry and observability exports are not part of the public v1 local
claim unless explicitly configured and verified. Internal trace, audit, metric,
and health surfaces may exist locally.

## Deletion And Control

Users are responsible for securing and backing up the host where Friday runs.
Where the product exposes delete, revoke, pause, rollback, or reset controls,
those controls should be treated as part of the privacy and safety surface.

If you publish logs, bug reports, screenshots, or audit artifacts, redact local
paths, credentials, private content, provider responses, and channel identifiers
unless the disclosure is intentional and safe.
