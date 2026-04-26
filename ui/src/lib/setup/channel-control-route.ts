export const SETUP_CHANNEL_CONTROL_ROUTE_STEPS = [
  {
    zh: "渠道消息",
    en: "Channel message",
  },
  {
    zh: "会话与身份",
    en: "Session and identity",
  },
  {
    zh: "编排引擎",
    en: "Orchestration engine",
  },
  {
    zh: "Agent、工具、skills、记忆",
    en: "Agent, tools, skills, memory",
  },
  {
    zh: "安全审批后回复",
    en: "Reply after safety gates",
  },
] as const;

export const SETUP_CHANNEL_CONTROL_GUARDS = [
  {
    zh: "所选渠道可以请求 Friday 已启用的完整能力。",
    en: "Selected channels can request Friday's full enabled capability set.",
  },
  {
    zh: "它们不能绕过权限、预算、审批、human gate 或敏感操作限制。",
    en: "They cannot bypass permissions, budget, approvals, human gates, or sensitive-action limits.",
  },
] as const;

export const SETUP_CHANNEL_CONTROL_CONFIRMATION = {
  zh: "我确认：这些渠道可以让 Friday 使用已启用能力执行任务；敏感操作仍会要求我确认。",
  en: "I understand: these channels can ask Friday to use enabled capabilities; sensitive actions still require my confirmation.",
} as const;
