/**
 * Decision Engine — handles simple intents locally without LLM calls,
 * and ranks tools based on context.
 *
 * Locally decidable patterns:
 *  - Greetings ("hello", "hi", "你好")
 *  - Status queries ("status", "health", "运行情况")
 *  - Help requests ("help", "帮助", "what can you do")
 *  - Cancel/stop commands ("stop", "cancel", "取消")
 *
 * All other intents defer to the LLM as before.
 */

import type {
  FridayDecisionContext,
  FridayDecisionEngine,
  FridayLocalDecision,
} from "./friday-agent-decision-engine.types.js";
import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";

// ─── Intent patterns ────────────────────────────────────────────

interface IntentPattern {
  name: string;
  regex: RegExp;
  action: "respond";
  confidence: number;
}

const GREETING_PATTERN: IntentPattern = {
  name: "greeting",
  regex: /^\s*(hello|hi|hey|yo|greetings|good\s+(morning|afternoon|evening)|你好|嗨|哈喽|早上好|下午好|晚上好)\s*[!.?]*\s*$/i,
  action: "respond",
  confidence: 0.95,
};

const STATUS_PATTERN: IntentPattern = {
  name: "status",
  regex: /^\s*(status|system\s*status|health|健康|运行情况|状态|how\s+are\s+you|are\s+you\s+(ok|running|alive))\s*[?!.]*\s*$/i,
  action: "respond",
  confidence: 0.9,
};

const HELP_PATTERN: IntentPattern = {
  name: "help",
  regex: /^\s*(help|帮助|what\s+can\s+you\s+do|你能做什么|你会什么|capabilities|功能|features|usage)\s*[?!.]*\s*$/i,
  action: "respond",
  confidence: 0.95,
};

const CANCEL_PATTERN: IntentPattern = {
  name: "cancel",
  regex: /^\s*(stop|cancel|abort|取消|停止|算了吧?|never\s*mind|nevermind)\s*[!.?]*\s*$/i,
  action: "respond",
  confidence: 0.9,
};

const INTENT_PATTERNS: IntentPattern[] = [
  GREETING_PATTERN,
  STATUS_PATTERN,
  HELP_PATTERN,
  CANCEL_PATTERN,
];

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

function responseForIntent(name: string, task: string): string {
  const zh = containsChinese(task);
  switch (name) {
    case "greeting":
      return zh
        ? [
            "嗨，我在。你可以直接告诉我想让 Friday 做什么。",
            "",
            "我现在可以帮你处理任务、创建或运行 Skills、看系统状态、诊断问题；涉及敏感操作时会先发审批让你确认。",
          ].join("\n")
        : [
            "Hello, I'm here. Tell me what you want Friday to handle.",
            "",
            "I can help with tasks, skills, system status, and diagnosis. Sensitive actions will pause for approval first.",
          ].join("\n");
    case "status":
      return zh
        ? [
            "Friday 正在运行，可以接收任务。",
            "",
            "- Agent：在线",
            "- Skills：可以在 Skills 页面查看已安装能力",
            "- Workflows：可以在 Workflows 页面查看自动化",
            "",
            "如果你要更详细的诊断，可以直接说“检查系统健康”。",
          ].join("\n")
        : [
            "Friday is running and ready.",
            "",
            "- Agent: online",
            "- Skills: check the Skills page for installed capabilities",
            "- Workflows: check the Workflows page for automations",
            "",
            "For deeper diagnostics, ask me to run a health check.",
          ].join("\n");
    case "help":
      return zh
        ? [
            "你可以直接用自然语言给 Friday 派任务。",
            "",
            "- 自动化：创建/运行 workflows，安排重复任务",
            "- Skills：安装、创建、运行技能",
            "- 诊断与修复：查问题、给方案、需要时自修复",
            "- 渠道：飞书/Telegram/Discord 对话入口",
            "",
            "涉及 MCP、第三方安装、生成工具、写配置或敏感操作时，我会先问你批准。",
          ].join("\n")
        : [
            "You can give Friday tasks in plain language.",
            "",
            "- Automation: create and run workflows, schedule recurring work",
            "- Skills: install, create, and run skills",
            "- Diagnosis: investigate issues and suggest or apply fixes",
            "- Channels: Feishu, Telegram, and Discord entry points",
            "",
            "MCP, third-party installs, generated tools, config writes, and sensitive actions pause for approval.",
          ].join("\n");
    case "cancel":
      return zh
        ? "收到，当前操作已停止。"
        : "Got it, I've stopped the current operation.";
    default:
      return zh ? "我在。你直接说要做什么就行。" : "I'm here. Tell me what you want to do.";
  }
}

// ─── Factory ────────────────────────────────────────────────────

export function createDefaultFridayDecisionEngine(): FridayDecisionEngine {
  return {
    canDecideLocally(context: FridayDecisionContext): boolean {
      // Only attempt local decisions on the first turn (no history)
      if (context.turnIndex > 0) return false;

      const task = context.task.trim();
      // Skip long messages — likely complex requests
      if (task.length > 120) return false;

      return INTENT_PATTERNS.some((p) => p.regex.test(task));
    },

    async decideLocally(context: FridayDecisionContext): Promise<FridayLocalDecision> {
      const task = context.task.trim();

      for (const pattern of INTENT_PATTERNS) {
        if (pattern.regex.test(task)) {
          return {
            action: "respond",
            response: responseForIntent(pattern.name, task),
            confidence: pattern.confidence,
            reason: `Matched local intent pattern: ${pattern.name}`,
          };
        }
      }

      // Fallback — should not reach here if canDecideLocally was called first
      return {
        action: "defer_to_llm" as const,
        confidence: 0,
        reason: "no matching local intent pattern",
      };
    },

    rankTools(
      context: FridayDecisionContext,
      tools: FridayAgentToolDefinition[],
    ): FridayAgentToolDefinition[] {
      // Boost tools seen in recent successful episodes (reorder, never remove)
      const recentActions = context.worldState?.recentActions;
      if (!recentActions || recentActions.length === 0) return tools;

      // Count tool usage frequency in recent actions
      const freq = new Map<string, number>();
      for (const step of recentActions) {
        freq.set(step.action, (freq.get(step.action) ?? 0) + 1);
      }

      // Stable sort: frequently-used tools first, rest unchanged
      return [...tools].sort((a, b) => {
        const fa = freq.get(a.name) ?? 0;
        const fb = freq.get(b.name) ?? 0;
        return fb - fa; // Higher frequency first
      });
    },
  };
}
