<p align="right">
  <a href="README.md">English</a>
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>陪你一起成长的 AI。</strong><br>
  自部署。技能驱动。有记忆。先审批再行动。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-brightgreen?style=flat-square" alt="Node >=22">
  <img src="https://img.shields.io/badge/License-GPL--3.0--only-blue?style=flat-square" alt="GPL-3.0-only">
  <img src="https://img.shields.io/badge/npm-%40thesongzhu%2Ffriday-red?style=flat-square" alt="@thesongzhu/friday">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/ci.yml/badge.svg" alt="CI">
</p>

---

## Friday 是什么？

Friday 是一个自部署 Agent OS，目标是让你的 AI 真正能在本机做事，同时不假装自己是万能系统。

它可以对话、调用已安装技能、在缺少技能时走可审核的技能生成流程、运行工作流、保留长期上下文、诊断失败、提出修复方案，并在高风险动作前请求你批准。你使用自己的模型/API Key。Friday 默认跑在本机，敏感凭证应该放在环境变量或托管 secret 引用里。

长期愿景是一个 **AI 自动化员工**：不是被动聊天机器人，而是一个有边界的 operator，会理解你的上下文，把重复工作沉淀成技能或工作流，并在可检查、可回滚、可审计的前提下越用越顺手。

## 为什么是现在？

最近中文和英文社区围绕 [Hermes Agent](https://hermes-agent.ai/)、[Agent 记忆](https://hermes.xaapi.ai/features/memory)、[技能系统](https://docs.openclaw.ai/skills) 和 [Agent 安全边界](https://docs.openclaw.ai/security) 的讨论，反复集中在几个问题上：

- 记忆不能只是更长上下文，必须有结构、检索和人类可见性。
- 技能让 Agent 变强，但不可信技能也是供应链和本地执行风险。
- 自我进化只有在能沉淀成可复用产物、测试、证据和回滚路径时才有意义。
- 自我修复必须对破坏性、凭证相关、生产敏感动作保持有监督。
- 上下文压缩和模糊指令可能丢掉关键边界，所以审批和审计轨迹非常重要。

Friday 的方向很实际：把记忆、技能、工作流、可观测性和审批门禁做成产品能力，而不是把一切赌在一条无限对话里。

## Friday 现在能做什么？

### 技能与工具

- 发现已安装和内置技能，包括你从没主动用过的技能。
- 在技能路由启用时，优先为 review、QA、发布、工作流、安全、写作、画图、自动化等任务选择合适的已安装技能。
- 扫描本机 AI 技能位置，例如 `~/.claude`、`~/.cursor`、`~/.codex`、本地项目技能目录、工作流目录和 Friday 托管技能目录。
- 把支持的来源导入或转换成 Friday 技能，然后验证、安装、刷新注册表，并通过 ID 或意图直接调用。
- 在转换器能识别清楚能力时，支持转换 `SKILL.md` 风格技能、ADK 风格技能、n8n 节点、OpenAPI/GPT Actions、代码仓库、压缩包、Git URL 和桌面录制。
- 当没有现成技能适配时，走技能生成流程：澄清问题、生成草稿文件、安全检查、自测证据、审批、保存，并立即刷新技能注册表。
- 如果新技能没有定义清楚，Friday 应该先问你，而不是乱写。它不是万能自动补全系统。

### 记忆与上下文

- 从 `context/AGENTS.md`、`context/SOUL.md`、`context/USER.md`、`context/MEMORY.md` 和 `memory/` 下的每日笔记加载工作区上下文。
- 用带置信度和衰减的学习偏好，让语气、直接程度和引导风格逐渐适配你。
- 在运行态配置完成后，通过 API 搜索记忆和会话历史。
- 保持记忆人类可读、可编辑，而不是只藏在不透明向量里。

### 工作流与自动化

- 用可视化方式把技能、条件、规则和证据串成工作流。
- 通过产品 API 部署工作流草稿，而不是手动串联 compile、publish、run、export 和 trace。
- 运行自动化、重试失败、暴露证据，并在重复失败时暂停。
- 在 fleet 已配置时，把任务放到 hub 或已注册 satellite 上执行。

### 自我修复与可观测性

- 检测事件、诊断可能原因、提出修复、执行低风险修复、验证结果，并在需要时回滚或暂停。
- 对高风险或破坏性改动要求明确批准。
- 向 operator 展示 trace、审计日志、健康状态、成本、SLO、告警、重试证据和规则决策。
- Expert autonomy 是可选且有边界的，仍受策略、审批和运行态权限约束。

### 渠道与桌面

- 在凭证和通道接线完成后连接 Discord、Slack、Telegram、WhatsApp、Signal、LINE、IRC、QQ、飞书和 Webchat。
- 在 native companion 和系统权限准备好后执行点击、输入、截图、滚动、拖拽、App/window 操作。
- 对不可用集成返回明确 blocked 状态，而不是静默降级。

## Friday 不是什么？

- 它不是不受限制的自主黑客或系统管理员。
- 它不会安全地无审查运行任意第三方技能。
- 它不保证每个 GitHub 仓库、文档或模糊想法都能自动变成可运行技能。
- 它不会绕过模型能力限制。小模型或弱工具调用模型的 Agent 行为会受限。
- 它不会替你承担主机安全、API Key 管理、网络暴露和扩展安装风险。

## 快速开始

**方式一 - npm 包**

```bash
npm install -g @thesongzhu/friday
friday start
# 打开 http://localhost:3141
```

**方式二 - 源码安装**

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
npm install
npm run build
npm start
# 打开 http://localhost:3141
```

**方式三 - Docker 源码构建**

```bash
docker compose -f docker/docker-compose.yml up --build
# 打开 http://localhost:3141
```

第一次运行的具体路径取决于你的 provider key、本机权限，以及启用了哪些可选能力。

## 下载与分发

| 平台 | 方式 | 当前状态 |
| --- | --- | --- |
| macOS / Linux / Windows | `npm install -g @thesongzhu/friday` | npm 已发布 `1.0.0` |
| 源码 | `git clone` + `npm install` + `npm run build` | 可用 |
| Docker | `docker compose -f docker/docker-compose.yml up --build` | 可从本仓库构建 |
| macOS 原生 App | DMG/Homebrew 打包脚本 | 流水线存在，公开签名产物尚未发布 |
| Linux 包 | `.deb` / `.AppImage` 打包脚本 | 流水线存在，公开产物尚未发布 |
| Windows 原生安装器 | MSI/native shell | 规划中 |
| iOS / Android | 移动端/远程控制台 | 规划中 |

官方 npm 包是 `@thesongzhu/friday`。npm 上无 scope 的 `friday` 是无关项目。

## 技能生命周期

```bash
friday list
friday import ./my-skill.friday.tgz
friday import ./path/to/SKILL.md
friday import https://github.com/example/skill-repo.git
```

支持的导入路径是有边界的。Friday 可以识别、转换、验证和安装支持的技能类来源，但不清楚的来源应该先澄清或人工审核，再执行。

## 安全姿态

- 凭证使用环境变量或 `secret://...` 引用。
- 安装第三方技能前先审查。
- 除非已经配置认证、CORS、TLS/代理和最小权限访问，否则不要把 Friday 暴露到公网。
- 桌面、Shell、浏览器、文件、渠道和网络工具都是强能力，需要明确策略约束。
- 发布或部署前运行检查：`npm run release:verify:repo` 用于仓库健康，`npm run release:verify` 用于真实运行态证明。
- 漏洞报告见 [安全策略](.github/SECURITY.md)。

## 开源发布状态

Friday 是开源软件，许可证以 [LICENSE](LICENSE) 为准。公开发布源码快照前请先看 [开源发布审查](docs/open-source-release-review.md)。当前仓库包含生成的审计/证明产物，干净公开发布前应该先裁剪或脱敏。

---

<p align="center">
  <a href="docs/README.md">文档中心</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href=".github/CONTRIBUTING.md">参与贡献</a> ·
  <a href=".github/SECURITY.md">安全策略</a> ·
  <a href="LICENSE">GPL-3.0-only 许可</a>
</p>

<p align="center">
  <sub>持续成长，但不丢边界。</sub>
</p>
