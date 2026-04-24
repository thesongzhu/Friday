<p align="right">
  <a href="README.md">English</a>
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>陪你一起成长的 AI。</strong><br>
  既是永远在线的<b>个人 AI 助手</b>，也是会自我修复、能把重复工作沉淀成 skill 的<b>自动化员工</b>。<br>
  自部署 · 自带模型 · 先审批再行动
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-brightgreen?style=flat-square" alt="Node >=22">
  <img src="https://img.shields.io/badge/License-GPL--3.0--only-blue?style=flat-square" alt="GPL-3.0-only">
  <img src="https://img.shields.io/badge/npm-%40thesongzhu%2Ffriday-red?style=flat-square" alt="@thesongzhu/friday">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/ci.yml/badge.svg" alt="CI">
</p>

---

## Friday 是什么？

Friday 是一个自部署 Agent OS，一份代码同时给你两个产品：

- **个人 AI** —— 对话、技能、记忆、多通道收件箱、桌面控制。永远在线，跑在你自己的硬件上。
- **自动化员工** —— 工作流、自我修复、审批门禁、技能自动生成。有边界的 operator，把重复工作沉淀成可复用产物。

你用自己的模型/API Key。Friday 默认跑在本机，敏感凭证放在环境变量或托管 secret 引用里。高风险动作必走显式审批。

## 它长什么样？

四个 30 秒快照：既是个人 AI，也是自动化员工，看完就知道 Friday 怎么挣自己的工资。

### 1. 自我进化，也自我修复

你说一次：*"以后周报别罗列细节，只要 3 个洞察。"* Friday 写进 memory。下周周报 skill 自动改写。再下一周 skill 跑挂了——Friday 自己 diagnose 原因、改 skill、跑 self-test，通过后再 ping 你确认才复用。

### 2. 凌晨 3 点 Incident，它先动手你后批

Slack `#alerts` 弹 5xx 突增。workflow 触发，Friday diagnose 出 OOM，写好调高内存的 PR，推到 Slack 等你点 approve。你点一下，merge，跑 verify workflow，回执 ✓。每一步修复都要你点头。

### 3. 半小时的重复活，看一次就变 skill

每周一你花 30 分钟看 GitHub PR 队列、拉 metrics、写总结。Friday 看你跑一次 → 问 4 个澄清问题 → 生成 skill → self-test 通过 → 你审一遍存进 registry。下周一自动跑，你只读输出。

### 4. 偏好不靠反复说

你说一次：*"我用 pnpm，部署只走 GitHub Actions。"* Friday 写进 `memory/preferences.md`，带置信度和时间戳。三个月后开新项目，它自动用 pnpm + 写 GHA workflow。哪天你换 bun？打开那个 markdown 改一行，不需要"重新训练"。

## 为什么是现在？

最近中文和英文社区围绕长期记忆、可复用技能、自我修复循环和工具安全边界的讨论，反复集中在几个问题上：

- 记忆不能只是更长上下文，必须有结构、检索和人类可见性。
- 技能让 Agent 变强，但不可信技能也是供应链和本地执行风险。
- 自我进化只有在能沉淀成可复用产物、测试、证据和回滚路径时才有意义。
- 自我修复必须对破坏性、凭证相关、生产敏感动作保持有监督。
- 上下文压缩和模糊指令可能丢掉关键边界，所以审批和审计轨迹非常重要。

Friday 的方向很实际：把记忆、技能、工作流、可观测性和审批门禁做成产品能力，而不是把一切赌在一条无限对话里。

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

| 平台 | 方式 | 状态 |
| --- | --- | --- |
| macOS / Linux / Windows | `npm install -g @thesongzhu/friday` | npm 已发布 `1.0.0` |
| 源码 | `git clone` + `npm install` + `npm run build` | 可用 |
| Docker | `docker compose -f docker/docker-compose.yml up --build` | 可从本仓库构建 |

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

## 社区

- **Discord** —— 加入 [discord.gg/qXQRFg2u](https://discord.gg/qXQRFg2u) 聊问题、共享技能、讨论 roadmap。
- **Issues** —— bug 和功能反馈走 [GitHub Issues](https://github.com/thesongzhu/Friday/issues)。
- **安全** —— 漏洞报告见 [安全策略](.github/SECURITY.md)。

## 开源发布状态

Friday 是开源软件，许可证以 [LICENSE](LICENSE) 为准。公开发布源码快照前请先看 [开源发布审查](docs/open-source-release-review.md)。

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

## 第三方声明

Friday 包含面向第三方 Agent 生态格式和行为的兼容与适配工作。上游版权和许可声明见 [NOTICE](NOTICE)。
