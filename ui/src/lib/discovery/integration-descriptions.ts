export interface IntegrationDescription {
  zh: string;
  en: string;
}

// Map program name (lowercase) or bundleId to description
const DESCRIPTIONS: Record<string, IntegrationDescription> = {
  "google chrome": { zh: "在浏览器中帮你做网页 QA 测试、数据抓取和自动填表", en: "Help you do web QA testing, data scraping, and form automation in the browser" },
  "chrome": { zh: "在浏览器中帮你做网页 QA 测试、数据抓取和自动填表", en: "Help you do web QA testing, data scraping, and form automation" },
  "safari": { zh: "在 Safari 中帮你做网页测试和数据抓取", en: "Help you do web testing and data scraping in Safari" },
  "discord": { zh: "管理 Discord 频道消息、自动回复和通知", en: "Manage Discord channel messages, auto-reply, and notifications" },
  "slack": { zh: "管理 Slack 消息、自动回复和发送提醒", en: "Manage Slack messages, auto-reply, and send reminders" },
  "xcode": { zh: "分析 iOS/macOS 项目、生成文档、辅助调试", en: "Analyze iOS/macOS projects, generate docs, assist debugging" },
  "claude": { zh: "与 Claude 桌面应用协作，共享上下文和记忆", en: "Collaborate with Claude desktop app, share context and memory" },
  "codex": { zh: "与 Codex 协作，共享代码分析和自动化能力", en: "Collaborate with Codex, share code analysis and automation" },
  "node": { zh: "运行 Node.js 脚本、管理依赖、自动化构建", en: "Run Node.js scripts, manage dependencies, automate builds" },
  "python3": { zh: "执行 Python 数据分析、生成报告、自动化任务", en: "Execute Python data analysis, generate reports, automate tasks" },
  "docker": { zh: "监控容器状态、自动重启、日志分析", en: "Monitor container status, auto-restart, log analysis" },
  "git": { zh: "管理代码版本、自动化 PR 和代码审查", en: "Manage code versions, automate PRs and code reviews" },
  "gh": { zh: "管理 GitHub Issues、PR 和 Actions", en: "Manage GitHub Issues, PRs, and Actions" },
  "npm": { zh: "管理 npm 包、依赖更新和发布", en: "Manage npm packages, dependency updates, and publishing" },
  "brew": { zh: "管理 Homebrew 包和系统依赖", en: "Manage Homebrew packages and system dependencies" },
  "ollama": { zh: "管理本地 AI 模型、运行推理", en: "Manage local AI models, run inference" },
  "psql": { zh: "查询和管理 PostgreSQL 数据库", en: "Query and manage PostgreSQL databases" },
  "go": { zh: "编译和测试 Go 项目", en: "Build and test Go projects" },
  "rg": { zh: "快速全文搜索代码库", en: "Fast full-text search across codebases" },
  "ffmpeg": { zh: "处理音视频文件、转码和剪辑", en: "Process audio/video files, transcode and edit" },
};

export function getIntegrationDescription(programName: string, locale: string): string | null {
  const key = programName.toLowerCase().trim();
  const desc = DESCRIPTIONS[key];
  if (desc) return locale === "zh" ? desc.zh : desc.en;
  return null;
}
