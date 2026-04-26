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

## Related References

- [Current Source Of Truth](../current-source-of-truth.md)
- [Vision](../VISION.md)
- [Getting Started](../getting-started.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
