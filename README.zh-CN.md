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
  <a href="https://discord.gg/x2rd4WsY"><img src="https://img.shields.io/discord/1234567890?style=flat-square&logo=discord&label=Discord&color=5865F2" alt="Discord"></a>
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
拖拽式 DAG 工作流编辑器。可视化串联技能、规则和条件，一键部署到中心节点或边缘卫星，实时执行追踪。

</td>
</tr>
<tr>
<td>

### 10 个聊天平台
Discord · Slack · Telegram · WhatsApp · Signal · LINE · IRC · QQ · 飞书 · 网页聊天 — 一个 Friday，哪里都能找到它。支持按频道白名单和健康监控。

</td>
<td>

### 记忆 & 自适应人格
16 种 MBTI 性格模板，9 个可调维度。学习到的偏好采用贝叶斯置信度衰减。Friday 的语气、直接程度和引导风格会逐渐适配你。

</td>
</tr>
<tr>
<td>

### 有监督的自我修复
闭环事件管线：检测 → 诊断 → 风险评级 → 提出方案 → 等待批准 → 执行 → 验证 → 必要时回滚 → 学习经验。连续失败 3 次自动暂停。

</td>
<td>

### 规则引擎 & 策略
YAML 规则 DSL，支持 allow/deny/warn/audit 四种决策。执行前后钩子守护每个动作。100% 决策可追溯，零不安全操作逃逸。

</td>
</tr>
<tr>
<td>

### 技能生成 & 安全
AI 驱动的技能生成，保存前自动自测。Shell 安全扫描器拦截 20+ 种危险模式。每个技能都有沙箱隔离、安全验证和版本追踪。

</td>
<td>

### 桌面自动化
跨平台桌面控制：macOS / Windows / Linux 上的点击、输入、截图、滚动、拖拽。支持操作录制与回放，所有动作必须经过规则引擎。

</td>
</tr>
<tr>
<td>

### 分布式集群
Hub + Satellite 架构。基于能力的工作流调度，心跳监控和离线检测，卫星不可用时明确阻塞而非静默降级。集群面板 `/fleet`。

</td>
<td>

### 安全 & 审计
JWT + RBAC 认证。SHA-256 哈希链防篡改审计日志。SSRF 防护。能力授权支持过期与撤销。多租户就绪。SIEM 导出（JSONL + Webhook）。

</td>
</tr>
<tr>
<td>

### 全链路可观测
分布式追踪贯穿所有模块。SLO 监控 + 多窗口燃烧率告警。按提供商的成本看板。告警管线：Webhook、邮件、Slack、PagerDuty。

</td>
<td>

### macOS 原生伴侣应用
Swift/AppKit 原生桌面应用。launchd 开机自启。Passkey 远程访问。桌面快捷操作与通知联动。Sparkle 增量自动更新。

</td>
</tr>
<tr>
<td>

### BYOK — 你的密钥，你的数据
直连 OpenAI、Anthropic、Google 或任何兼容提供商。提供商健康监控、熔断器、预算紧张时自动降级到更便宜的模型。

</td>
<td>

### 质量门禁 & 验收
逐产物 pass/fail/warn 判定，附完整证据链。支持 Schema、阈值、质量和自定义检查。确定性 > 99.5%，逃逸率 < 1%。每个决策可审计。

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

技能就像 Friday 的 App。从压缩包导入、或用 AI 自动生成。每个技能都有沙箱隔离、安全验证和版本追踪。

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
  <a href="https://discord.gg/x2rd4WsY">Discord</a> ·
  <a href="LICENSE">MIT 许可</a>
</p>

<p align="center">
  <sub>用心构建。与你同行。</sub>
</p>
