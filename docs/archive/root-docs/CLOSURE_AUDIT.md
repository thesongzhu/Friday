> Status: Superseded historical root document. Retained for archive purposes; prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md) and the [`Documentation Hub`](../../README.md).

# CLOSURE_AUDIT (End-to-End Closure and Gaps)

闭环判定标准:
1. 必须有用户可见输出（API payload / channel message / artifact file / download content）。
2. 失败路径必须有用户可理解提示 + error code + 可定位上下文（routeId/toolName/correlationId）。
3. 仅静态阅读不计入闭环。

## 1) Promise Closure Status

| Promise | Status | Breakpoint (if any) | Why | Minimal Fix | Recommended Fix |
|---|---|---|---|---|---|
| P1 Agent run terminal response | 闭环 | - | API 返回 terminal status + response，E2E 已验证 | keep | add chaos test for provider jitter |
| P2 No-tool evidence enforcement | 闭环 | - | 0-tool 外部任务会被强制验证重试；无证据会标注 unverified | keep | add metric counter for evidence retry rate |
| P3 web_fetch->browser fallback | 闭环 | - | recoverable web_fetch error 自动 fallback；SSRF block 不绕过 | keep | add fallback telemetry field in run detail |
| P4 Browser artifact delivery | 闭环 | - | run `images[]` + file size > 0 已被 E2E assert | keep | add artifact checksum assertion in e2e |
| P5 Session continuity/isolation | 闭环 | - | same session 累积、跨 session 隔离、并发同/多用户无串话已验证 | keep | add higher-volume soak profile |
| P6 Workflow timeline | 闭环 | - | run 启动后 timeline 可读且稳定 | keep | add long-run timeline pagination soak test |
| P7 Workflow evidence export/download | 闭环 | - | download 非空、missing export 404 code 已验证 | keep | test disk-full scenario |
| P8 Scheduler run status fidelity | 闭环 | - | non-completed automation run 显式转为 scheduler error | keep | add retry idempotency assertion |
| P9 Channel user-visible delivery | 闭环 | - | 业务成功/失败 + transport primary send failure fallback/retry 全部有 E2E 注入验证 | keep | extend same injection to slack/telegram adapters |
| P10 Provider detect validation | 闭环 | - | VALIDATION/UNREACHABLE 错误路径可见可读 | keep | add network timeout backoff tests |
| P11 Observability not enabled message | 闭环 | - | 404 message 明确，不再黑盒 | keep | add enabled-path e2e once observability runtime is wired |
| P12 Correlation chain end-to-end | 闭环 | - | run/tool/delivery failure链路具备 `routeId+correlationId`，并在 audit/run-events 可串联 | keep | add trace explorer UI query test |

## 2) Problems Found and Fixed in This Audit

| ID | Problem | Fix Location | Result |
|---|---|---|---|
| F-001 | 外部任务两轮都 0 tool call，仍可能给出“已完成”口吻 | `src/agent/runtime/friday-agent-runtime.ts:471-505,1186-1225` | 已修；增加 evidence re-prompt + unverified标注 |
| F-002 | `web_fetch` 失败后无自动恢复路径 | `src/agent/runtime/friday-agent-runtime.ts:1778-1928` | 已修；recoverable errors 自动 fallback 到 browser open/snapshot |
| F-003 | “已记录反馈”可能无持久化证据 | `src/agent/runtime/friday-agent-runtime.ts:1249-1278` | 已修；无 feedback/memory_store 成功证据时标注未验证 |
| F-004 | scheduler 可能对 failed run 记为 ok（假阳性） | `src/hub/friday-hub-bootstrap.ts:1739-1746` | 已修；非 completed 抛 `E-SCHED-AUTOMATION-RUN-FAILED` |
| F-005 | workflow async 异常定位弱 | `src/workflows/services/friday-workflow-execution-service.ts` | 已修；统一 `E-WF-RUN-ASYNC-001..004` |
| F-006 | channel primary delivery fail 没有自动化注入验证 | `test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts` (`G2 delivery failure closure`) | 已修；首发失败 -> fallback/retry -> 用户侧可见 + session/audit闭环 |
| F-007 | run/tool/delivery 关联字段不完整 | `src/agent/runtime/friday-agent-runtime.ts`, `src/hub/friday-hub-bootstrap.ts`, `test/unit/agent/runtime/friday-agent-runtime.test.ts` | 已修；`routeId/correlationId/errorCode` 在关键失败路径可验证 |
| F-008 | 并发（同用户多请求 + 多用户并发）无真实测试 | `test/e2e/mock/friday-mock-multi-turn.e2e.test.ts` (`concurrency closure`) | 已修；并发完成率、runId 唯一性、会话隔离均断言通过 |

## 3) Required Situations Coverage Audit

| Situation | Verdict | Evidence |
|---|---|---|
| tool 调用成功但输出未回传 | ✅ | parity suite 验证 webchat/discord 用户可见闭环 |
| tool 调用成功但 primary delivery 失败 | ✅ | `G2 delivery failure closure` 故障注入，验证 fallback retry + audit |
| tool 超时/卡死回收 | ✅ | `e2e-workflow-timeout-chain.log` |
| tool 参数非法 | ✅ | setup detect validation + web_fetch invalid param tests |
| 权限拒绝/沙箱约束 | ✅ | `e2e-mock-security.log` |
| 并发/状态隔离 | ✅ | `e2e-mock-multi-turn.log` 并发闭环 case |
| 重试策略可重试/不可重试 | ✅ | scheduler backoff + channel delivery retry path |
| 本地/服务环境差异 | ✅ | `integration-browser-resilience.log` + `e2e-api-health.log` |
| 崩溃恢复 | ✅ | stale-run recovery unit + workflow async catch |
| 同一 correlation id 串链 | ✅ | unit runtime event assertions + parity delivery-failure audit assertions |
| 输出回传失败（transport send fail） | ✅ | parity delivery-failure injection case |

## 4) Risk Summary

- 安全风险: 低。SSRF/readOnly/command injection 防护已覆盖并通过 E2E。
- 稳定性风险: 低到中。核心承诺闭环已验证；剩余主要是更高并发量级的容量风险（非功能正确性风险）。
- 可观测风险: 低。关键失败链路具备 error code + route + correlation + audit 定位信息。

## 5) Optional Hardening (non-blocking)

1. 将 channel 传输层故障注入扩展到 Slack/Telegram/WhatsApp 适配器。
2. 增加高并发 soak（>100 并发）并纳入 nightly 回归。
3. 加一个自动脚本把 `runId` 关联查询（run events + audit lines）固化成诊断命令。
