<p align="right">
  <a href="README.md">English</a>
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>陪你一起成长的 AI。</strong><br>
  自部署。技能驱动。持续学习。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-brightgreen?style=flat-square" alt="Node ≥22">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/badge/Tests-10000%2B-success?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/TypeScript-strict-blue?style=flat-square" alt="TypeScript">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/ci.yml/badge.svg" alt="CI">
</p>

---

## Friday 是什么？

Friday 不只是一个 AI 工具 — 它是一个**会学习你的习惯、记住你的偏好、用得越多越懂你**的自部署 AI 伙伴。

用你自己的 API Key，像装 App 一样安装技能，连接你常用的聊天平台。Friday 跑在你自己的机器上，数据完全属于你。

> 把 Friday 想象成你的私人 AI：一开始是个靠谱的助手，慢慢变成你做任何事都离不开的搭档。

---

## Friday 能做什么

<table>
<tr>
<td width="50%">

### 对话 & 执行
30+ 内置工具，52+ 技能。让 Friday 帮你调研、写作、编程、分析、自动化 — 它真的会去做，不是光说不练。

</td>
<td width="50%">

### 可视化工作流
拖拽式工作流编辑器。可视化设计复杂的自动化流程，一键部署，剩下的交给 Friday。

</td>
</tr>
<tr>
<td>

### 10 个聊天平台
Discord · Slack · Telegram · WhatsApp · Signal · LINE · IRC · QQ · 飞书 · 网页聊天 — 一个 Friday，哪里都能找到它。

</td>
<td>

### 记忆 & 学习
Friday 会记住重要的事。向量记忆引擎、自适应沟通风格、还有一个随着你的偏好不断进化的 AI 性格。

</td>
</tr>
<tr>
<td>

### 自我修复
出问题了？Friday 会自动检测、诊断根因、提出带风险评级的修复方案，等你批准后再执行。

</td>
<td>

### 安全 & 可观测
JWT 认证、角色权限、防篡改审计链、成本看板、完整可观测性。一切尽在你的掌控。

</td>
</tr>
</table>

---

## 快速开始

**方式一 — npm（推荐）**

```bash
npm install -g friday
friday start
# 打开 http://localhost:3141
```

**方式二 — 源码安装**

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday && npm install && npm run build
npm start
```

**方式三 — Docker**

```bash
cd docker
docker-compose up -d
# 打开 http://localhost:3141
```

> **第一次用？** Friday 会引导你完成初始设置 — 连接 API Key、选个性格，就可以开始了。

---

## 下载

| 平台 | 方式 | 状态 |
|------|------|------|
| **macOS / Linux / Windows** | `npm install -g friday` | 可用 |
| **macOS** | 原生 DMG + Homebrew | 即将推出 |
| **Linux** | `.deb` / `.AppImage` | 可用 |
| **Docker** | `docker-compose up -d` | 可用 |
| **iOS / Android** | 移动端控制台 | 规划中 |

---

## 你可能想知道的

<details>
<summary><b>BYOK — 自带 API Key</b></summary>

Friday 不会通过任何第三方服务器存储或代理你的 API Key。你直接连接 OpenAI、Anthropic、Google 或任何兼容 OpenAI 的提供商。你的密钥，你的数据，你做主。

</details>

<details>
<summary><b>工作区上下文</b></summary>

Friday 会从项目中加载性格和记忆文件：

- `context/AGENTS.md` — 仓库规则和任务路由
- `context/SOUL.md` — 回复风格和性格设定
- `context/USER.md` — 你的偏好设置
- `context/MEMORY.md` — 持久化的项目知识
- `memory/YYYY-MM-DD.md` — 每日笔记

直接编辑这些文件，Friday 立即适应 — 无需重启。

</details>

<details>
<summary><b>技能系统</b></summary>

技能就像 Friday 的 App。从市场安装、从压缩包导入、或用 AI 自动生成。每个技能都有沙箱隔离、安全验证和版本追踪。

```bash
friday list              # 查看已安装技能
friday import ./my.tgz   # 安装一个技能
```

</details>

<details>
<summary><b>安全第一</b></summary>

- JWT 认证 + 基于角色的访问控制
- 哈希链式审计日志（防篡改）
- Shell 安全扫描器拦截危险命令
- 所有外部请求的 SSRF 防护
- 能力授权支持过期和撤销
- 所有破坏性操作需要明确批准

</details>

---

<p align="center">
  <a href="docs/README.md">文档中心</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href=".github/CONTRIBUTING.md">参与贡献</a> ·
  <a href=".github/SECURITY.md">安全策略</a> ·
  <a href="LICENSE">MIT 许可</a>
</p>

<p align="center">
  <sub>用心构建。与你同行。</sub>
</p>
