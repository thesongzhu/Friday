# MCP + Conversion Capability Boundary

Status: Active contract
Last updated: 2026-03-05

## Purpose

This document defines what Friday can and cannot do today for:

1. MCP interoperability (client/server roles).
2. Conversion head capability (external formats -> Friday skill drafts/packages).

It is intentionally strict. Anything outside this contract must fail fast with a clear error.

## MCP Boundary

### Supported now

- MCP client mode with external servers from `FRIDAY_MCP_SERVERS`.
- Tool discovery and invocation:
  - `initialize`
  - `tools/list`
  - `tools/call`
- Basic MCP context surfaces:
  - `resources/list`
  - `resources/read`
  - `prompts/list`
  - `prompts/get`
- Transport:
  - `stdio` (default; backward compatible).
  - `http` (JSON-RPC over HTTP POST).
- Server/tool policy controls:
  - per-server tool allowlist (`policy.toolAllowlist`)
  - per-server rate limit (`policy.rateLimit.maxCalls/windowMs`)

### Not guaranteed

- Full MCP feature parity across all third-party servers.
- Streaming tool calls over MCP transports.
- Cross-process distributed rate-limit coordination (policy is process-local).

## Conversion Head Boundary

### Supported source formats (contract)

- `friday-package`
- `clawdbot-skill-md`
- `n8n-node`
- `openai-gpt-action`
- `code-repo`
- `undocumented-api`
- `desktop-recording`

`unknown` is reserved for detection output and diagnostics only.

### Supported shape of conversion output

- Friday skill draft(s) with:
  - manifest
  - UI schema
  - generated files
  - conversion report
- Optional install and pack flows via `/v1/skills/import` and `/v1/skills/pack`.

### Not guaranteed

- Converting any arbitrary GUI app without explicit adapter/recording path.
- Semantic equivalence for every external workflow/runtime model.
- Automatic, zero-touch auth/secrets onboarding for unknown external systems.

## Failure Contract

When source/system is outside boundary:

- Detection must return `null` or low-confidence non-match.
- Convert/import must fail with explicit validation/domain errors.
- No silent partial installs.

## Compatibility Rules

- `FRIDAY_MCP_SERVERS` legacy stdio config remains valid.
- New transport/policy fields are additive and optional.
- `src/skills/converter` remains canonical converter runtime surface.
