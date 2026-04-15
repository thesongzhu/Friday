> Status: Current parity audit. Date: 2026-04-09 (America/Los_Angeles)

# Friday vs OpenClaw Reddit 问题对标矩阵

判定词汇只使用：

- `same defect confirmed`
- `similar risk`
- `no evidence in Friday`
- `not applicable`
- `blocked`

## 主题矩阵

| 主题 | OpenClaw Reddit 信号 | Friday 判定 | Friday 证据 | 备注 |
| --- | --- | --- | --- | --- |
| 浏览器 / 控制面在更新后行为错位或管理失灵 | [Browser extension management broken after update](https://www.reddit.com/r/openclaw/comments/1m8x4hs/browser_extension_management_broken_after_update/) | `similar risk` | Friday 本次确认过 README `/agent` 旧路由漂移、`browser-qa-report` redirect false-green、`MCP` 假开关 | Friday 已修掉一部分同类“表面与真实行为不一致”的问题，但该类风险确实存在过 |
| 过多审批 / 工具升级反复确认 | [OpenClaw keeps asking approval on tool upgrade](https://www.reddit.com/r/openclaw/comments/1m3v7qv/openclaw_keeps_asking_approval_on_tool_upgrade/) | `similar risk` | Friday 的审批体系是主动设计出来的，`/assistant`、approval routes、auto-fix 都以 supervised 为主；`Automations`/operator 面术语也偏重 | Friday 没出现完全同症的死循环证据，但审批摩擦是现实风险，不应按“零摩擦自动化”叙事发布 |
| 会话 / 任务连续性差，长跑或后台材料丢失 | [Session files keep getting deleted after 3 days](https://www.reddit.com/r/openclaw/comments/1m1gt7f/session_files_keep_getting_deleted_after_3_days/) | `blocked` | Friday smoke 通过了 memory / session / file-tool roundtrip；weekly soak 仍未收口 | 这类问题要等 soak 结束才能给最终判定 |
| 配置校验静默拒绝 / 网关配置不透明 | [Config validator silently rejected my gateway token](https://www.reddit.com/r/openclaw/comments/1lxdb48/config_validator_silently_rejected_my_gateway/) | `same defect confirmed` | Friday 本次实锤发现本地验证工具会因 token secret 解析问题制造 `INVALID_SIGNATURE` 假失败；匿名浏览器暴力巡检还触发了 auth rate limit | 不是同一条代码，但同一类“配置/鉴权问题导致操作者得到错误或不够清楚的反馈”已经在 Friday 出现 |
| 控制台看到的能力与实际可操作面不一致 | 同上两类 Reddit 公开抱怨的组合模式 | `same defect confirmed` | 插件生命周期 API live 但无独立 UI；MCP 原有假 toggle；`Usage` 原 placeholder 估算；README 旧路径漂移 | 这是 Friday 目前最明确的一类同型问题 |
| 渠道网关稳定性（Telegram/Slack/Discord 等） | 无足够稳定 Reddit 主题可直接对上，且本地环境未配置完整外部渠道 | `blocked` | 当前审计环境 `channelCount` 有限，外部渠道测试关闭 | 不能主观放行 |
| 订阅 / 凭据 / 提供方配置混乱 | Reddit 上围绕 token / gateway / config 的帖子可归到这一类 | `similar risk` | Friday 的 provider/setup 当前主链路可用，但 `Usage` 仍是估算，auth/login 在高频试探下会被 rate limit，且本次验证工具 secret 解析曾经出错 | Friday 主链路比公开抱怨更稳，但同类认知负担存在 |
| 文档、控制面、运行时三者不同步 | Reddit 多个问题实际都落在这类不一致 | `same defect confirmed` | `/agent` vs `/command-center`、插件 UI 缺口、坏链、placeholder 文案，这次都实锤过 | 本次已修掉一部分，但仍需发布前继续守住 truth alignment |

## 总结

### Confirmed Facts

- Friday 并没有暴露出“核心运行完全不能用”的 OpenClaw 类灾难症状。
- Friday 已经确认存在 **同类问题族**：文档/控制面/运行时不同步、配置/鉴权反馈不够直接、operator 能力与普通用户期待不一致。
- 这些问题中，一部分已经在本次审计内修复。

### Inference

- 如果明天发布时把高级能力继续包装成“所有用户都能直接点点点完成”，Friday 很容易重演 OpenClaw 社区抱怨的那类期望落差。
- 如果把高级能力按 operator/API-first truth 明确降级叙述，Friday 当前状态更接近 `ready-with-explicit-de-scope`，而不是“会踩 Reddit 同坑”。

### Recommendation

1. 发布文案不要把插件、MCP、automations、operator console 说成统一 beginner UI。
2. 把本次修掉的 truth bugs 写进发布前变更说明，尤其是验证工具签名问题和 browser QA redirect false-green。
3. 等 weekly soak 结束后，再判断 Friday 在“后台连续性 / 长跑稳定性”上是否会复现 OpenClaw 类问题。
