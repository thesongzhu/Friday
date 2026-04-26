import type {
  FridayAgentToolDefinition,
  FridayAgentToolResult,
} from "../model/friday-agent.types.js";
import type {
  FridayAgentConversationContext,
  FridayAgentExecutionContext,
} from "./friday-agent-runtime.types.js";

export type FridayAgentPromptProfile = "standard" | "minimal";

export type FridayAgentToolRoutingProfile =
  | "trivial"
  | "status"
  | "memory"
  | "web"
  | "browser"
  | "code"
  | "skill"
  | "workflow"
  | "system"
  | "autonomy"
  | "media"
  | "general";

export interface FridayAgentToolRoutingDecision {
  profile: FridayAgentToolRoutingProfile;
  promptProfile: FridayAgentPromptProfile;
  workspaceContextPolicy: "auto" | "skip";
  selectedToolNames: string[];
  deferredToolNames: string[];
  selectedToolPacks: string[];
  reason: string;
}

export interface FridayAgentToolPackRequest {
  pack: string;
  reason?: string;
  loadedToolNames: string[];
}

const TOOL_PACKS: Record<Exclude<FridayAgentToolRoutingProfile, "trivial">, string[]> = {
  status: ["capabilities", "task_status"],
  memory: ["memory_search", "memory_store", "feedback", "memory_extract"],
  web: ["web_search", "web_fetch"],
  browser: ["web_search", "web_fetch", "browser", "canvas"],
  code: ["read", "write", "edit", "exec", "web_fetch", "web_search", "skills_list", "skill_run", "task_status"],
  skill: ["skills_list", "skill_run", "skill_generate", "skill_import", "read", "write", "edit", "exec"],
  workflow: ["workflow_run", "workflow_generate", "task_status", "cron", "skills_list", "skill_run"],
  system: ["system", "desktop", "provider", "setup", "setup_assistant", "capabilities", "task_status"],
  autonomy: ["autonomous", "controlled_autonomy", "spawn_subagent", "get_subagent", "agents_list", "task_status", "system"],
  media: ["image_analysis", "pdf_parse", "tts", "browser", "web_fetch", "read"],
  general: ["capabilities", "task_status", "memory_search", "web_search", "web_fetch", "read"],
};

const FRIDAY_KNOWN_TOOL_NAMES = new Set<string>([
  ...Object.values(TOOL_PACKS).flat(),
  "mcp",
  "message",
  "gateway",
  "sessions",
  "nodes",
  "xhs",
]);

const DYNAMIC_TOOL_PACKS = Object.keys(TOOL_PACKS).filter((name) =>
  name !== "general" && name !== "status",
);

export function resolveFridayAgentToolNamesForPacks(
  packNames: Iterable<string>,
  availableTools: readonly FridayAgentToolDefinition[],
  disabledToolNames?: ReadonlySet<string>,
): string[] {
  const available = new Set(availableTools.map((tool) => tool.name));
  const selected = new Set<string>();
  for (const packName of packNames) {
    const toolNames = TOOL_PACKS[packName as Exclude<FridayAgentToolRoutingProfile, "trivial">];
    if (!toolNames) continue;
    for (const toolName of toolNames) {
      if (available.has(toolName) && !(disabledToolNames?.has(toolName) ?? false)) {
        selected.add(toolName);
      }
    }
  }
  return [...selected];
}

export function resolveFridayAgentToolRouting(input: {
  task?: string;
  tools: readonly FridayAgentToolDefinition[];
  disabledToolNames?: ReadonlySet<string>;
  images?: readonly string[];
  conversationContext?: FridayAgentConversationContext;
  executionContext?: FridayAgentExecutionContext;
}): FridayAgentToolRoutingDecision {
  const task = input.task?.trim() ?? "";
  const availableTools = input.tools.filter((tool) => !(input.disabledToolNames?.has(tool.name) ?? false));
  const availableToolNames = new Set(availableTools.map((tool) => tool.name));
  const profile = classifyFridayToolRoutingProfile({
    task,
    images: input.images,
    conversationContext: input.conversationContext,
    executionContext: input.executionContext,
  });

  if (profile === "trivial") {
    return {
      profile,
      promptProfile: "minimal",
      workspaceContextPolicy: "skip",
      selectedToolNames: [],
      deferredToolNames: availableTools.map((tool) => tool.name),
      selectedToolPacks: [],
      reason: "short simple chat with no current, workspace, memory, or device intent",
    };
  }

  const selectedToolPacks = selectFridayToolPacksForProfile(profile);
  const selected = new Set(resolveFridayAgentToolNamesForPacks(
    selectedToolPacks,
    availableTools,
    input.disabledToolNames,
  ));

  // Preserve small custom-tool runtimes and focused tests without reopening the full production registry.
  if (availableTools.length <= 6) {
    for (const tool of availableTools) {
      if (!FRIDAY_KNOWN_TOOL_NAMES.has(tool.name)) {
        selected.add(tool.name);
      }
    }
  }

  const selectedToolNames = [...selected].filter((name) => availableToolNames.has(name));
  const deferredToolNames = availableTools
    .map((tool) => tool.name)
    .filter((name) => !selected.has(name));

  return {
    profile,
    promptProfile: "standard",
    workspaceContextPolicy: profile === "status" ? "skip" : "auto",
    selectedToolNames,
    deferredToolNames,
    selectedToolPacks,
    reason: `matched ${profile} intent`,
  };
}

export function createFridayAgentToolPackRequestTool(input: {
  availableTools: readonly FridayAgentToolDefinition[];
  disabledToolNames?: ReadonlySet<string>;
  onRequest: (request: FridayAgentToolPackRequest) => void;
}): FridayAgentToolDefinition {
  return {
    name: "request_tool_pack",
    description:
      "Load a deferred Friday tool pack for the next model turn when the current visible tools are insufficient.",
    parameters: {
      type: "object",
      properties: {
        pack: {
          type: "string",
          enum: DYNAMIC_TOOL_PACKS,
          description: "Tool pack to load for the next model turn.",
        },
        reason: {
          type: "string",
          description: "Brief reason this pack is required.",
        },
      },
      required: ["pack"],
      additionalProperties: false,
    },
    async execute(args): Promise<FridayAgentToolResult> {
      const pack = typeof args.pack === "string" ? args.pack : "";
      const loadedToolNames = resolveFridayAgentToolNamesForPacks(
        [pack],
        input.availableTools,
        input.disabledToolNames,
      );
      if (loadedToolNames.length === 0) {
        return {
          content: JSON.stringify({
            status: "unavailable",
            pack,
            loadedToolNames,
            message: `No enabled tools are available for tool pack '${pack}'.`,
          }),
          isError: true,
        };
      }

      const request: FridayAgentToolPackRequest = {
        pack,
        loadedToolNames,
        ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
      };
      input.onRequest(request);
      return {
        content: JSON.stringify({
          status: "loaded",
          pack,
          loadedToolNames,
          instruction: "Continue the task using the newly loaded tools on the next model turn.",
        }),
      };
    },
  };
}

export function getFridayAgentToolPackNames(): string[] {
  return [...DYNAMIC_TOOL_PACKS];
}

function selectFridayToolPacksForProfile(
  profile: Exclude<FridayAgentToolRoutingProfile, "trivial">,
): string[] {
  switch (profile) {
    case "browser":
      return ["web", "browser"];
    case "autonomy":
      return ["status", "autonomy", "system"];
    case "system":
      return ["status", "system"];
    case "workflow":
      return ["status", "workflow"];
    case "skill":
      return ["skill"];
    case "code":
      return ["code"];
    case "media":
      return ["media", "web"];
    case "memory":
      return ["memory"];
    case "web":
      return ["web"];
    case "status":
      return ["status"];
    case "general":
      return ["general"];
  }
}

function classifyFridayToolRoutingProfile(input: {
  task: string;
  images?: readonly string[];
  conversationContext?: FridayAgentConversationContext;
  executionContext?: FridayAgentExecutionContext;
}): FridayAgentToolRoutingProfile {
  const text = input.task.toLowerCase();
  const hasImages = (input.images?.length ?? 0) > 0;
  if (hasImages || /\b(image|photo|screenshot|pdf|audio|tts|subtitle|caption)\b|图片|截图|照片|语音|字幕/u.test(text)) {
    return "media";
  }
  if (input.executionContext?.channelControlRoute === "full_agent") {
    return "general";
  }
  if (input.conversationContext?.turnKind === "status_check") {
    return "status";
  }
  if (/\b(status|progress|capabilit(?:y|ies)|what can you do|enabled|disabled|running task|current task)\b|状态|进度|能力|能做什么/u.test(text)) {
    return "status";
  }
  if (/\b(remember|memory|preference|preferences|recall|previously|past conversation|stored fact)\b|记住|记忆|偏好|之前|上次/u.test(text)) {
    return "memory";
  }
  if (/\b(browser|click|open page|navigate|login|interactive|screenshot|playwright|spa|reddit|twitter|x\.com)\b|浏览器|点击|打开网页|登录|截图/u.test(text)) {
    return "browser";
  }
  if (/\b(latest|current|today|news|search|lookup|source|url|https?:\/\/|documentation|docs)\b|最新|今天|最近|新闻|搜索|查一下|资料|来源/u.test(text)) {
    return "web";
  }
  if (/\b(workflow|automation|schedule|cron|trigger|dag|pipeline)\b|工作流|自动化|定时|触发器/u.test(text)) {
    return "workflow";
  }
  if (/\b(skill|skills|plugin|marketplace)\b|技能|插件|市场/u.test(text)) {
    return "skill";
  }
  if (/\b(provider|model|api key|oauth|setup|configure|config|install|connect|integration|slack|discord|telegram|service)\b|模型|供应商|密钥|配置|安装|连接|集成/u.test(text)) {
    return "system";
  }
  if (/\b(desktop|mouse|keyboard|app|window|system|handoff|approval|device)\b|桌面|鼠标|键盘|窗口|应用|系统/u.test(text)) {
    return "system";
  }
  if (/\b(autonom(?:y|ous)|subagent|delegate|agent fleet|background task)\b|自主|子代理|委托|后台任务/u.test(text)) {
    return "autonomy";
  }
  if (/\b(code|repo|repository|file|read|write|edit|fix|debug|test|build|lint|typescript|javascript|python|git|commit|diff|pr|pull request|terminal|shell|command)\b|代码|仓库|文件|修复|调试|测试|构建|命令/u.test(text)) {
    return "code";
  }
  if (isFridayTrivialSimpleChat(input.task, input.conversationContext)) {
    return "trivial";
  }
  return "general";
}

function isFridayTrivialSimpleChat(
  task: string,
  conversationContext?: FridayAgentConversationContext,
): boolean {
  const normalized = task.trim();
  if (normalized.length === 0 || normalized.length > 180) {
    return false;
  }
  if (
    conversationContext?.turnKind === "follow_up"
    || conversationContext?.turnKind === "continue_active_task"
    || conversationContext?.selectedBlocks?.length
  ) {
    return false;
  }

  const blocked =
    /\b(latest|current|today|news|search|lookup|url|https?:\/\/|file|repo|code|fix|debug|test|build|install|configure|provider|api key|oauth|browser|desktop|memory|remember|workflow|skill|agent|autonomous)\b|最新|今天|最近|新闻|搜索|文件|仓库|代码|修复|安装|配置|浏览器|桌面|记住|记忆|工作流|技能|自主/u;
  if (blocked.test(normalized.toLowerCase())) {
    return false;
  }

  const arithmetic =
    /^(?:what\s+is|calculate|compute|solve)?\s*[-+*/().\d\s=？?]+$/i;
  if (arithmetic.test(normalized)) {
    return true;
  }

  const simpleGreeting =
    /^(hi|hello|hey|thanks|thank you|good morning|good afternoon|good evening|你好|嗨|谢谢|早上好|晚上好)[!.。！\s]*$/iu;
  if (simpleGreeting.test(normalized)) {
    return true;
  }

  const simpleStaticQuestion =
    /^(what is|who is|define|explain briefly|translate|how many|how much)\b/i;
  const simpleChineseQuestion =
    /^(什么是|谁是|解释一下|简单解释|翻译|多少)\b/u;
  return simpleStaticQuestion.test(normalized) || simpleChineseQuestion.test(normalized);
}
