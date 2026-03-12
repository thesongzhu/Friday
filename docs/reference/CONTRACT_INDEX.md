> Status: Current reference. For active product truth and operational boundaries, start with [`docs/current-source-of-truth.md`](../current-source-of-truth.md).

# CONTRACT Index

Source: `CONTRACT.md`
Date: 2026-03-05 (America/Los_Angeles)

| promise_id | promise_name | entrypoint | input example | expected user-visible output (success) | failure expectation / error codes |
|---|---|---|---|---|---|
| P1 | CLI runtime boot + API exposure | CLI | `friday start --host 127.0.0.1 --port 3141` | API reachable and returns JSON envelopes | startup failure exits with explicit log context (e.g. bind error); HTTP failures include `requestId` |
| P2 | Structured HTTP envelope | Web/API | `GET /v1/health`; `GET /v1/auth/me` | success envelope `{ok:true,data,requestId}` | error envelope `{ok:false,error:{code,message},requestId}` (`UNAUTHORIZED`,`VALIDATION_ERROR`,...) |
| P3 | Agent run traceable output | Web/API | `POST /v1/agent/runs {task,providerId,model}` | run accepted/completed and retrievable | explicit run errors (`AGENT_RUN_NOT_FOUND`,`AGENT_RUN_ALREADY_TERMINAL`, tool/runtime errors) |
| P4 | Workflow lifecycle closed-loop | Web/API | `POST /v1/workflow-runs {workflowId,versionNumber}` | start -> terminal state -> timeline/evidence available | explicit code + readable error envelope |
| P5 | Channel ingress/egress delivery | Discord/Webchat | inbound channel message event/frame | outbound user-visible reply text + optional attachment | explicit fallback delivery error with `E-CH-OUTBOUND-001` + correlation context |
| P6 | Browser artifact delivery | Agent runtime via API/channel | task that triggers browser screenshot/snapshot | non-empty screenshot/artifact referenced in output | explicit tool error text / event `errorCode` on failure |
| P7 | Desktop capability explicit behavior | Agent runtime | task that triggers desktop `session_info` | enabled: desktop result returned | disabled: explicit hint `FRIDAY_DESKTOP_ENABLED=true` |
| P8 | Marketplace gating (entitlement/install) | Web/API | run request with `marketplaceListingId` | run proceeds when entitled+installed | `MARKETPLACE_ENTITLEMENT_REQUIRED` or `MARKETPLACE_INSTALL_REQUIRED` |
| P9 | Not-enabled feature explicit response | Web/API | `GET /v1/observability/traces` (feature off) | clear not-enabled message | no fake success; structured error envelope returned |
| P10 | Cross-stage traceability fields | Web/API + Agent + Channels | run + delivery within one correlation scope | logs/events include `requestId/runId/correlationId/routeId` | error paths keep `error_code` + contextual IDs |

## Schema Reference

- Route-level request/response schemas are defined in API route handlers and Zod/Ajv validation layers under `src/api/http/routes/*`.
- Contract tests in `tests/contract/**` validate the practical request/response shape and user-visible closure behavior for each promise.
