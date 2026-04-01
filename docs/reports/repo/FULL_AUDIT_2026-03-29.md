# Friday 全面审计报告

- 审计日期: 2026-03-29
- 时区: America/Los_Angeles
- 审计分支: `codex/full-audit-2026-03-29`
- 审计基线提交: `792409140fa85113ec7003170f24b4e5e1b216e4`
- 审计模式: 只审计，不修复
- 保留的既有未跟踪文件: `docs/reports/repo/BEDE50D_RELEASE_GATE_REVIEW_2026-03-29.md`

## 1. 范围

本次审计覆盖以下范围:

- 静态质量门与发布门禁
- API / 契约 / 模块集成
- UI / 浏览器路由 / 关键用户路径
- skills 生命周期与 starter skills 真实接入
- local closure
- real OpenAI 本地 live 路径
- macOS companion / release 本地验证
- 安全 starter skill 与文档承诺一致性

本次未纳入或被环境阻塞的范围:

- Cloud live 验证
- Anthropic OAuth live 验证
- 各消息渠道 live 验证
- Docker smoke
- Windows 原生发布验证
- iOS / Android 实机分发验证

## 2. 环境事实

以下为确认事实，不包含推断:

- 操作系统: macOS arm64
- Node: `v22.22.0`
- npm: `10.9.4`
- Playwright: `1.58.2`
- Swift: `6.1.2`
- `OPENAI_API_KEY`: 已存在
- `docker`: 当前不可用
- `dotnet`: 当前不可用
- 审计时工作树已恢复到只剩 1 个既有未跟踪报告文件
- 事实真相源优先采用 `docs/current-source-of-truth.md` 与当前运行时行为

## 3. 已执行检查

以下为确认已执行的命令或测试面:

- `npm run release:verify`
- `npm run closeout:phase1`
- `npm run closeout:phase2`
- `npm run closeout:phase3`
- `npm run closeout:phase4`
- `npm run closeout:phase5`
- `npm run closeout:marketplace`
- `npx vitest run test/e2e/setup-wizard.e2e.test.ts test/e2e/mock/friday-mock-security.e2e.test.ts test/e2e/mock/friday-mock-web-routing.e2e.test.ts test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts`
- `npm run test:e2e:closure:local`
- `FRIDAY_E2E_LIVE_OPENAI=1 FRIDAY_E2E_TARGET=local npx vitest run test/e2e/live/friday-real-journeys.e2e.test.ts -t 'Scenario 1|Scenario 5|Scenario 8'`
- `npm run check:cross-platform-release-inputs`
- `npm run check:companion:release-env`
- `npm run verify:companion:native`
- 本地运行 Friday 后，人工浏览器 QA 覆盖 `/`、`/setup`、`/login`、`/onboarding`、`/home`、`/assistant`、`/workflows`、`/skills`、`/fleet`、`/observability`、`/command-center`、`/agent`
- 实际执行 starter skills:
  - `browser-qa-report`
  - `security-review`

## 4. 总体结论

### 4.1 确认事实

- 本地核心门禁总体通过。`release:verify`、各 `closeout:phase*`、`closeout:marketplace`、高风险补充 E2E、`test:e2e:closure:local`、macOS companion 本地验证都通过。
- `test:e2e:closure:local` 在 `2026-03-30T06:08:26.634Z` 产出结论: `Product Ready (Local): GO`。
- Friday 在本机 macOS 上的本地产品闭环、主要模块联动、skills 生命周期、OpenAI 本地 live 核心路径，均有实跑通过证据。
- 但审计同时发现 5 个明确问题，其中 3 个为高优先级。
- 当前不能把 Friday 视为“跨平台分发就绪”。现有代码和文档更接近“本地 macOS 产品闭环已基本打通，但跨平台发布承诺仍未完成证据闭环”。

### 4.2 判断

- 从本次审计证据看，Friday 的本地产品能力和核心集成度明显强于其对外发布成熟度。
- 主要风险不在“系统完全跑不起来”，而在“个别真实入口失效”、“starter skill 可能给出错误成功结论”、“跨平台发布声明超前于就绪证据”。

## 5. 发现的问题

### F1. `browser-qa-report` 会在跳转到错误页面时给出“无阻塞问题”结论

- 严重度: High
- 模块: starter skills / browser QA / UIX template execution
- 分类: 代码缺陷
- 影响:
  - 可用性: 是
  - 稳定性: 间接影响
  - 已兑现承诺: 是
- 复现:
  - 在已认证的本地 Friday 会话中执行 `browser-qa-report`
  - 输入 URL: `http://127.0.0.1:51800/home`
- 直接证据:
  - 实际执行返回摘要: `Browser QA report: no blocking issues detected on http://127.0.0.1:51800/onboarding.`
  - 同一响应中的 `details.requestedUrl` 为 `/home`
  - 同一响应中的 `details.finalUrl` 为 `/onboarding`
  - 同一响应中的 `findings` 为空数组
  - `skills/browser-qa-report/index.mjs` 的 `buildFindings()` 只检查 HTTP 状态、console errors、page errors、request failures、title 为空，不检查 `requestedUrl !== finalUrl`
  - `skills/browser-qa-report/index.mjs` 的摘要逻辑会直接基于 `findings.length === 0` 输出“no blocking issues”
- 相关代码:
  - `skills/browser-qa-report/index.mjs:18-58`
  - `skills/browser-qa-report/index.mjs:117-126`
- 结论:
  - 该 starter skill 可能在页面被重定向、落到 onboarding、login 或其他非目标页时，仍然输出“检查通过”的假阳性结果。

### F2. Home 页 `Show all goals` 入口跳到了不存在的向导 ID

- 严重度: High
- 模块: UI / guided flow / home entrypoint
- 分类: 代码缺陷
- 影响:
  - 可用性: 是
  - 稳定性: 否
  - 已兑现承诺: 是
- 复现:
  - 打开 Home 页
  - 点击 `Show all goals`
  - 前端会导航到 `/flow/browse`
  - 后端启动 `browse` wizard 时返回 404
- 直接证据:
  - `ui/src/routes/home-page.tsx:136` 写死为 `navigate("/flow/browse")`
  - `ui/src/router.tsx:180` 只定义了 `flow/:wizardId`
  - `src/uix/services/friday-uix-surface-service.ts:2036-2040` 仅接受已登记的 `wizardId`，未知值会抛出 `UIX_GUIDED_WORKFLOW_NOT_FOUND`
  - 实跑时，`/v1/uix/wizards/browse/start` 返回 404，错误码为 `UIX_GUIDED_WORKFLOW_NOT_FOUND`
- 相关代码:
  - `ui/src/routes/home-page.tsx:130-137`
  - `ui/src/router.tsx:179-185`
  - `src/uix/services/friday-uix-surface-service.ts:2036-2040`
- 结论:
  - 这是一个真实用户入口失效问题，不是文档问题，也不是测试环境噪音。

### F3. 跨平台下载 / 发布声明明显超前于发布就绪证据

- 严重度: High
- 模块: release readiness / docs / distribution claims
- 分类: 声明缺口 + 环境阻塞
- 影响:
  - 可用性: 间接影响
  - 稳定性: 否
  - 已兑现承诺: 是
- 复现:
  - 运行 `npm run check:cross-platform-release-inputs`
- 直接证据:
  - 该命令退出码为 `78`
  - 输出明确指出: `29 required inputs or evidence items are still missing.`
  - 缺失项覆盖 Apple 签名、notary profile、Sparkle keys、Homebrew 发布信息、iOS / Android 分发输入、Windows `dotnet` 与签名输入、clean-machine / device smoke evidence
  - `README.md` 仍在对外展示跨平台下载矩阵与“Required release channels for the current milestone”
  - `docs/ops/friday-cross-platform-downloads.md` 将 `macOS` 描述为 `Shipping beta baseline`
  - 对应证据文件仍然全部是 `Status: pending`
- 相关文档与证据:
  - `README.md:221-257`
  - `docs/ops/friday-cross-platform-downloads.md:7-43`
  - `docs/reports/ops/cross-platform-agent-os-beta-evidence/macos-15-clean-machine.md:21`
  - `docs/reports/ops/cross-platform-agent-os-beta-evidence/ios-latest-device-smoke.md:15`
  - `docs/reports/ops/cross-platform-agent-os-beta-evidence/android-latest-device-smoke.md:15`
  - `docs/reports/ops/cross-platform-agent-os-beta-evidence/windows-11-clean-machine.md:9`
- 结论:
  - 当前可以说“本地 macOS companion 和本地产品闭环有通过证据”，但不能说“跨平台发布 readiness 已完成”。
  - 这不是核心运行时代码故障，而是公开承诺与发布证据闭环之间存在明显差距。

### F4. 文档仍把 `/agent` 写成 operator 入口，但实际 operator 页面是 `/command-center`

- 严重度: Medium
- 模块: docs / routing / information architecture
- 分类: 声明缺口
- 影响:
  - 可用性: 是
  - 稳定性: 否
  - 已兑现承诺: 是
- 复现:
  - 打开 `/agent`
  - 实际路由会落到 `/home`
  - 打开 `/command-center`
  - 才会进入 operator 页面
- 直接证据:
  - `README.md:895` 仍写着本地桌面行为由 `/agent` 触发
  - `ui/src/router.tsx:200-205` 实际 operator 页面路径是 `/command-center`
  - `ui/src/router.tsx:290` 未匹配路径统一跳转 `/home`
  - 本地浏览器 QA 中，请求 `/agent` 的最终地址是 `/home`
- 相关代码与文档:
  - `README.md:895`
  - `ui/src/router.tsx:200-205`
  - `ui/src/router.tsx:290`
- 结论:
  - 这是信息架构和文档不一致问题，会直接误导操作者入口。

### F5. `docs/ops` 内多处相对链接写法错误，进入文档后会继续拼出错误路径

- 严重度: Medium
- 模块: docs / onboarding / ops
- 分类: 文档缺陷
- 影响:
  - 可用性: 是
  - 稳定性: 否
  - 已兑现承诺: 间接影响
- 复现:
  - 从 `docs/ops` 目录内打开对应文档
  - 点击写成 `./docs/ops/...` 的链接
- 直接证据:
  - 以下文档已经位于 `docs/ops` 下，但仍继续引用 `./docs/ops/...`
  - 这会形成错误的相对路径
- 相关文档:
  - `docs/ops/friday-cross-platform-downloads.md:12`
  - `docs/ops/friday-autostart-macos.md:5-6`
  - `docs/ops/friday-companion-release-macos.md:5-6`
  - `docs/ops/friday-agent-os-beta-onboarding.md:21`
- 结论:
  - 这是标准文档导航缺陷，主要影响运维、分发与 onboarding 体验。

## 6. 观察到但尚未升级为正式失败的问题

### O1. real OpenAI live Journey 在 skill import / converter 路径出现 `EISDIR` 警告

- 严重度: Low
- 模块: skills conversion / workflow import
- 分类: 待确认风险
- 影响:
  - 可用性: 暂未证实
  - 稳定性: 可能影响
  - 已兑现承诺: 暂不构成直接否定
- 直接证据:
  - `FRIDAY_E2E_LIVE_OPENAI=1 FRIDAY_E2E_TARGET=local npx vitest run test/e2e/live/friday-real-journeys.e2e.test.ts -t 'Scenario 1|Scenario 5|Scenario 8'` 执行时，Scenario 10 也被匹配执行并通过
  - 该场景 stderr 出现:
    - `[friday][n8n-node-converter] operation failed: EISDIR: illegal operation on a directory, read`
    - `[friday][openai-gpt-action-converter] operation failed: EISDIR: illegal operation on a directory, read`
- 结论:
  - 当前证据更像“噪音或容错路径触发”，因为场景最终通过。
  - 但这说明 converter 对目录输入的鲁棒性仍值得补查。

## 7. 已验证通过的面

以下为本次确认通过的范围:

- `release:verify` 总门禁通过
- `closeout:phase1` 到 `closeout:phase5` 全部通过
- `closeout:marketplace` 通过
- 补充高风险 E2E 通过:
  - setup wizard
  - mock security
  - mock web routing
  - OpenClaw parity closure
- `test:e2e:closure:local` 通过
- local provider detect / lifecycle 在 closure 中通过
- real OpenAI 本地 live 核心旅程通过:
  - first-time user journey
  - conversation -> response -> memory extraction
  - provider failover
  - import skill -> workflow -> execute
- macOS companion 本地 release 环境检查通过
- macOS native companion bundle 验证通过
- 本地浏览器 QA 中，以下路径在对应状态下无明显 console/page/request failures:
  - `/setup`
  - `/home`
  - `/assistant`
  - `/workflows`
  - `/skills`
  - `/fleet`
  - `/observability`
  - `/command-center`
- `security-review` starter skill 可被真实发现并执行，且返回结构化结果与报告文件

## 8. 未验证或被环境阻塞的面

以下范围不能被计为通过:

- Docker 相关 smoke: 当前环境缺少 `docker`
- Windows 原生发布: 当前环境缺少 `dotnet`，且 Windows 证据模板仍为 `pending`
- iOS / Android 实机分发 smoke: 证据模板仍为 `pending`
- Apple 签名 / notarization / Sparkle / Homebrew 正式发布输入: 缺失
- Cloud live 验证: 本次未跑
- Anthropic OAuth / channel live 验证: 本次未跑

## 9. 最终判断

### 9.1 事实

- Friday 在 `2026-03-29` 这次审计中，已经具备较强的本地 macOS 产品闭环证据。
- Friday 不是“处处都没打通”，相反，大部分核心模块、starter skills 生命周期、closure、OpenAI 本地 live 路径、macOS companion 本地验证，都已经真实跑通。
- 但它也不是“对外承诺完全兑现”的状态。

### 9.2 判断

- 如果结论只针对“本地 macOS 产品是否能跑、模块是否大体打通”，答案偏正面。
- 如果结论包含“starter skills 是否完全可信”、“入口是否无误”、“跨平台发布是否已兑现”，答案是否定的。
- 当前最值得优先盯住的，不是大面积重构，而是:
  - 修掉真实失效入口
  - 修掉 QA starter skill 的假阳性
  - 收紧公开发布声明，让它与现有证据保持一致
