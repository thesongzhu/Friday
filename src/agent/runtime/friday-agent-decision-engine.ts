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
  FridayDecisionEngine,
  FridayDecisionContext,
  FridayLocalDecision,
} from "./friday-agent-decision-engine.types.js";
import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";

// ─── Intent patterns ────────────────────────────────────────────

interface IntentPattern {
  name: string;
  regex: RegExp;
  action: "respond";
  response: string;
  confidence: number;
}

const GREETING_PATTERN: IntentPattern = {
  name: "greeting",
  regex: /^\s*(hello|hi|hey|yo|greetings|good\s+(morning|afternoon|evening)|你好|嗨|哈喽|早上好|下午好|晚上好)\s*[!.?]*\s*$/i,
  action: "respond",
  response:
    "Hello! I'm Friday, your AI automation assistant. How can I help you today? You can ask me to:\n\n" +
    "- **Create workflows** to automate repetitive tasks\n" +
    "- **Install skills** to extend my capabilities\n" +
    "- **Monitor systems** and get health reports\n" +
    "- **Diagnose issues** and suggest fixes\n\n" +
    "Just tell me what you'd like to do!",
  confidence: 0.95,
};

const STATUS_PATTERN: IntentPattern = {
  name: "status",
  regex: /^\s*(status|system\s*status|health|健康|运行情况|状态|how\s+are\s+you|are\s+you\s+(ok|running|alive))\s*[?!.]*\s*$/i,
  action: "respond",
  response:
    "I'm running and ready to help! Here's a quick overview:\n\n" +
    "- **Agent**: Online and processing requests\n" +
    "- **Skills**: Check the Skills page for installed capabilities\n" +
    "- **Workflows**: Check the Workflows page for active automations\n\n" +
    "For detailed system diagnostics, try asking me to \"run a health check\" or visit the Observability dashboard.",
  confidence: 0.9,
};

const HELP_PATTERN: IntentPattern = {
  name: "help",
  regex: /^\s*(help|帮助|what\s+can\s+you\s+do|你能做什么|你会什么|capabilities|功能|features|usage)\s*[?!.]*\s*$/i,
  action: "respond",
  response:
    "Here's what I can help you with:\n\n" +
    "**Automation**\n" +
    "- Create and manage workflows (multi-step automations)\n" +
    "- Generate and install skills (single-purpose scripts)\n" +
    "- Schedule recurring tasks\n\n" +
    "**Monitoring & Repair**\n" +
    "- Diagnose errors and suggest fixes\n" +
    "- Self-healing: automatically detect and repair issues\n" +
    "- System health monitoring\n\n" +
    "**Fleet Management**\n" +
    "- Manage satellite nodes (remote devices)\n" +
    "- Monitor fleet health and trust scores\n\n" +
    "**Getting Started**\n" +
    "- Just describe what you want in plain language\n" +
    "- Example: \"Create a workflow that backs up my database every night\"",
  confidence: 0.95,
};

const CANCEL_PATTERN: IntentPattern = {
  name: "cancel",
  regex: /^\s*(stop|cancel|abort|取消|停止|算了|never\s*mind|nevermind)\s*[!.?]*\s*$/i,
  action: "respond",
  response: "Got it, I've stopped the current operation. Let me know if you need anything else!",
  confidence: 0.9,
};

const INTENT_PATTERNS: IntentPattern[] = [
  GREETING_PATTERN,
  STATUS_PATTERN,
  HELP_PATTERN,
  CANCEL_PATTERN,
];

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
            response: pattern.response,
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
