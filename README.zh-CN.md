<p align="right">
  <a href="README.md">English</a>
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>可信的 AI Agent 应用层，用来把真实工作安全做完。</strong><br>
  你给目标，Friday 调用已配置工具，但把审批、记忆、证据和回滚留在闭环里。<br>
  本地优先 · 自带 Key · 先审批再行动 · 用户掌控 · 证据闭环
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-brightgreen?style=flat-square" alt="Node >=22">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/badge/npm-%40thesongzhu%2Ffriday-red?style=flat-square" alt="@thesongzhu/friday">
  <img src="https://img.shields.io/badge/Release%20Truth-public%20v1%20local%20candidate-blue?style=flat-square" alt="Release Truth: public v1 local candidate">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/ci.yml/badge.svg" alt="CI">
</p>

---

## Friday 是什么？

Friday 是一个自部署的个人 AI 和自动化执行系统：一个本地优先的 AI Agent 应用层，帮助 AI 把用户授权的目标变成可验证的真实工作。

它不应该像一个空白聊天框，而应该像一个私人的执行搭档：你给它目标，它先检查自己有什么能力，使用已配置能力，遇到必须人类处理的地方就明确停下来问你，然后执行、验证、记录经验。能力自获取和自升级闭环仍是审查门控下的在建能力，不应理解为已经完全自动化。

Friday 不是万能自动机。它不会替你注册账号、绕过验证码、付款、偷偷拿权限、或在没有凭证的情况下调用外部服务。它的目标是：能自己做的尽量自己做；必须你介入的地方说清楚；做完留下证据和可回滚路径。

## 当前发布状态

Friday 现在更诚实的状态是：**public v1 local candidate**，仅通过 **npm/source** 发布，不是「所有集成都 release-complete」。

- 当前 public claim 聚焦本地 UI、本地 runtime、BYOK setup、受监督 operator workflow、memory、evidence、approval-gated tool use，以及已配置的 Discord / Telegram / Lark+飞书 trusted-inbound（由 release SHA 的同 SHA Real Green Gate channel artifact 证明）。
- 当前证明链不 claim 出站渠道控制自动化、云端 live certification、外部 OTEL/Grafana export、桌面 / Homebrew / 公证 macOS / 移动端分发、"所有集成 live"、或 release-complete-all。
- Slack HTTP Events-API inbound 和 QQ 在本次发布中保持 **`unsupported`**。
- Real Green Gate 只有在 artifact 属于同一个 SHA、scenarios 非零、全部通过、blockers 为空时才算 release-proof eligible。
- `blocked_by_env`、mock-only、workflow success alone、stale artifact、wrong-SHA artifact 都不能算通过。
- `1.0.1` 的 dogfood gate 收口为 **`dogfood_partial_pass`**（UX 加权 7.78/10），并显式记录 `proof_pending` 头条项目（详见 [`docs/public-v1-local-candidate.md`](docs/public-v1-local-candidate.md)）：self-repair execute→rollback 端到端、self-upgrade 真实 mutation、skill install/update/delete 的 canonical-approval 流程、端到端 link-to-skill candidate→run、queue/retry 在 retry-eligible incident 上的 receipt loop、可丢弃 ledger 上的审计 tamper-negative、R1 Lark phase24d listener-shutdown bug、speed/cost 的 near_limit/over_limit UI 暴露、memory 单条目 `confidence`/`last_accessed` 暴露。

## 核心闭环

1. **你给目标。** 例如：“读这些 PDF，结合最新网页搜索，保存一份带引用的短总结。”
2. **Friday 检查能力。** 它会看文本、视觉、OCR、网页搜索、PDF、文件、浏览器、可选渠道、模型、记忆、workflow 是否可用。
3. **Friday 报告缺口或生成候选方案。** 它可以从已安装 skills、可信 catalog、MCP server、本地文件、包仓库、OpenAPI 文档和网页中找候选。生成或导入的 skill 先是 candidate，不会立刻变成可运行能力。
4. **需要人类时明确停下。** API key、OAuth、付费、验证码、登录、敏感权限、高风险动作都要用户确认。
5. **Friday 执行并验证。** 通过 skills、tools、workflow、浏览器/桌面控制或渠道适配器执行，然后检查结果。
6. **Friday 安全地成长。** 它可以沉淀可审计 memory、learned facts、provider 路由信号、setup recipe、candidate skill、eval 用例和失败教训。learned signals 不会自动变成不经确认的真理。

## Friday 现在能做什么

| 领域 | Friday 的目标能力 | 边界 |
| --- | --- | --- |
| 对话与任务执行 | 回答、规划、调用工具执行、汇报进展、失败恢复 | 取决于已配置 provider 和已授权工具 |
| 文本、视觉、OCR、PDF、文件 | 按能力路由到 provider 或内置解析器；缺能力时说明缺什么 | 视觉/OCR/TTS 依赖 provider 和凭证 |
| 网页与浏览器 | 使用配置好的网页搜索 provider、本地浏览器控制和 workflow | 登录、付款、验证码、敏感账号需要用户 |
| Skills 和 workflows | 在 lifecycle 闭合的路径上导入、验证、暂存、promote、运行、更新、回滚可复用能力 | 生成或导入的 skill 先是 candidate；必须通过 review、canary、promotion gate 才能变成可用能力；workflow upgrade proof 不等同于 skill lifecycle proof |
| 记忆与自我改进 | 沉淀显式偏好、learned facts、教训、provider 路由、recipes、evals、恢复记录 | 用户可见、可审计、可撤销；learned signals 不是隐藏模型训练、不经确认的真理，也不保证都会进入 prompt 并改变行为 |
| 自我修复 | 发现失败、诊断、提出修复，并且只在已接通、已配置、有证据的路径上执行低风险修复 | dispatcher 式 auto-fix 默认关闭；高风险或改数据的修复需要审批、receipt、rollback 或明确不可逆记录 |
| 可选渠道适配器 | 在 release SHA 上由同 SHA Real Green Gate channel artifact 证明的 Discord、Telegram、飞书/Lark trusted-inbound 已配置可用；其它已配置渠道作为可选 surface | 渠道是配置后才可用的能力；出站渠道控制自动化不属于 public v1 local release claim；Slack HTTP Events-API inbound 和 QQ 为 `unsupported`；敏感动作仍要确认 |
| 长期目标 | 对用户授权的 standing goals 生成 agenda、执行低风险事项、汇报证据 | Friday 接收用户目标，不主动发明无关长期议程 |

## 安装与启动

### 方式一 - npm 包

```bash
npm install -g @thesongzhu/friday
friday start
# 打开 http://localhost:3141
```

### 方式二 - 源码首次安装

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
bash scripts/ops/friday-first-run.sh
# macOS 也可以双击 "Friday Setup.command"
```

首次安装助手会安装依赖、构建 Friday、启动本机 runtime，并自动打开 setup 页面。在 macOS 上，它还会安装登录自启动和右上角菜单栏 companion，重启后 Friday 可以自己回来。如果你从 Desktop、Documents 或 Downloads 运行，它会先自动准备 `~/Friday` 这个 launchd 可安全启动的 runtime，再安装登录项。

### 方式三 - 手动源码启动

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
npm install
npm run build
npm start
# 打开 http://localhost:3141
```

### 方式四 - Docker 源码构建

```bash
docker compose -f docker/docker-compose.yml up --build
# 打开 http://localhost:3141
```

第一次启动会进入 setup：配置 provider、本机权限和可选能力。渠道配置是可选项，必须完成对应验证后才算可用。setup 完成后，再打开 Friday 应直接进入 Home。

## Provider 和 API Key

Friday 是 BYOK：你使用自己的模型、搜索和第三方 API 凭证。

每项能力都应该能回答四个问题：

- **我有没有这项能力？**
- **如果没有，缺的是什么？**
- **去哪里配置？**
- **配置完后能不能用真实任务验证？**

常见 provider 路径包括 OpenAI、豆包/火山方舟、Moonshot、Anthropic、Google、OpenRouter、Tavily、Serper、本地浏览器/PDF/文件工具、MCP server 和自定义 skill。缺 key 或缺账号不能算成功，必须显示成人类阻塞项，并告诉你下一步去哪配。

## 能力自获取（WIP）

当 Friday 缺少完成目标所需的能力时，目标闭环是：

```text
目标 -> 能力缺口 -> 候选来源 -> 沙箱/测试 -> 必要时审批 -> 安装/注册 -> doctor 验证 -> 执行任务
```

这不是当前版本的全自动承诺。当前版本可以报告缺口并覆盖闭环中的一部分流程；生成 skill、自升级、配置调整保真等路径仍是审查门控能力，需要继续压力测试。默认低风险步骤包括搜索、分析、生成草案和沙箱验证。下载代码、安装包、写配置、注册工具、shell、本地文件写入、外部网络调用都受 autonomy policy 控制。OAuth、付款、验证码、API key、敏感权限、生产写操作必须由用户介入。

## 记忆、自我成长和自我修复

Friday 的自我改进不是神秘黑盒，而是可检查的状态和产物：

- **记忆事实：** 偏好、项目规则、反复出现的上下文、用户纠正。
- **路由偏好：** 哪个 provider 更适合哪类任务。
- **Setup recipes：** 成功的配置、恢复和验证步骤。
- **Skills / workflows：** 生成或改进后的可复用能力，带测试和证据。
- **Eval 用例：** 修过的问题以后要继续通过。
- **失败教训：** 什么坏了、怎么修、什么时候该停止重试。

这些不会默认训练模型权重。它们应该可见、可审计、可编辑、可暂停、可删除。

## 安全模型

Friday 的原则很简单：重复、低风险、可验证的事情尽量自动化；不可逆、敏感、高风险的事情留给用户确认。

- 默认本地优先运行，本地保存状态。
- 自带 key，凭证应放在环境变量、托管 secret 引用或系统密钥管理里。
- 能力授权要有范围、理由、证据和过期时间。
- 高风险动作必须显式审批。
- 工具调用、workflow、自修复、渠道动作都要留下审计证据。
- 安装失败或生成能力失败时要支持回滚。
- 暴露到公网前必须明确配置认证、CORS、TLS/代理和最小权限。

## Friday 不是什么

- 它不是万能自动化系统。
- 它不是任何任务都能完全不问人的全自动系统。
- 它不会绕过登录、验证码、付款、平台规则或 provider 限制。
- 它不会无审查安全运行任意第三方代码。
- 它不会替你承担主机、API key、账号和渠道接入的安全责任。

## 文档

- [快速开始](docs/getting-started.md)
- [文档中心](docs/README.md)
- [信任模型](TRUST.md)
- [隐私](PRIVACY.md)
- [负责任使用](RESPONSIBLE_USE.md)
- [Roadmap](ROADMAP.md)
- [愿景](docs/VISION.md)
- [能力矩阵](docs/ops/friday-capability-matrix.md)
- [扩展 Friday](docs/EXTENDING.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [参与贡献](.github/CONTRIBUTING.md)
- [安全策略](.github/SECURITY.md)

## 下载与分发

| 平台 | 方式 | 状态 |
| --- | --- | --- |
| macOS / Linux / Windows | `npm install -g @thesongzhu/friday` | 当前 npm 已发布版本为 `1.0.0`；`1.0.1` candidate 已准备就绪（npm/source-only 发布），release SHA 上已完成 R5 同 SHA Real Green Gate 证明；npm 发布等待运营方显式授权 |
| 源码 | `git clone` + `npm install` + `npm run build` | 可用 |
| Docker | `docker compose -f docker/docker-compose.yml up --build` | 可从本仓库构建 |

官方 npm 包是 `@thesongzhu/friday`。npm 上无 scope 的 `friday` 是无关项目。
Linux 和 Windows 的桌面 companion 行为应以平台能力检查和 release evidence 为准，不应理解为原生桌面版本已经完成发布。`1.0.1` 不 claim 桌面、Homebrew、公证 macOS 或移动端发布。

## 社区

- **Discord** - [discord.gg/qXQRFg2u](https://discord.gg/qXQRFg2u)
- **Issues** - [GitHub Issues](https://github.com/thesongzhu/Friday/issues)
- **安全** - [SECURITY](.github/SECURITY.md)

## 许可证

Friday 使用 [MIT](LICENSE) 开源许可证。

## 第三方声明

Friday 包含面向第三方 Agent 生态格式和行为的兼容与适配工作。上游版权和许可声明见 [NOTICE](NOTICE)。
