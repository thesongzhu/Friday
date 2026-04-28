/**
 * Deterministic Dispatch — Serves classified `sync_immediate` requests
 * without invoking the LLM agent.
 *
 * Each handler calls an existing snapshot getter or service method and
 * formats the result as a plain-text response string.
 *
 * @module sessions/services/friday-deterministic-dispatch
 */

import type { FridayAgentCapabilitiesSnapshot } from "../../agent/tools/friday-agent-capabilities-tool.js";
import type { FridayAgentTaskStatusSnapshot } from "../../agent/tools/friday-agent-task-status-tool.js";
import { formatFridayDaemonStatus } from "../../daemon/friday-daemon-runtime.js";
import type { FridayDaemonStatus } from "../../daemon/friday-daemon.types.js";
import type { FridaySetupRecipe, FridaySetupRecipeRegistry } from "../../setup/friday-setup.types.js";
import type { FridayWorkflowApprovalService } from "../../workflows/services/friday-workflow-approval-service.types.js";
import type { FridayWorkflowExecutionService, FridayWorkflowRunEntity } from "#workflows";
import type { FridayExecutionClassification } from "./friday-execution-classifier.js";
import type { FridaySessionMessageRecord } from "../model/friday-session.types.js";

// ─── Types ───

export interface FridayDeterministicDispatchResult {
  readonly handled: boolean;
  readonly response?: string;
}

export interface FridayDeterministicDispatchDeps {
  readonly sessionMessageGetter?: (
    key: string,
    limit?: number,
  ) => Promise<FridaySessionMessageRecord[]> | FridaySessionMessageRecord[];

  readonly capabilitySnapshotGetter?: (input: {
    readOnly: boolean;
  }) => Promise<FridayAgentCapabilitiesSnapshot> | FridayAgentCapabilitiesSnapshot;

  readonly taskStatusSnapshotGetter?: (input: {
    runId?: string;
    sessionKey?: string;
    readOnly: boolean;
  }) => Promise<FridayAgentTaskStatusSnapshot> | FridayAgentTaskStatusSnapshot;

  readonly getDaemonStatus?: () => FridayDaemonStatus;

  readonly listMcpServers?: () => ReadonlyArray<{ id: string; transport?: string }>;
  readonly approvalService?: FridayWorkflowApprovalService;
  readonly workflowExecutionService?: FridayWorkflowExecutionService;
  readonly setupRecipeRegistry?: Pick<FridaySetupRecipeRegistry, "getByTarget">;
}

export interface DispatchDeterministicInput {
  readonly classification: FridayExecutionClassification;
  readonly task?: string;
  readonly sessionKey?: string;
  readonly runId?: string;
  readonly actorId?: string;
  readonly currentUserSequence?: number;
}

// ─── Dispatch ───

export async function dispatchDeterministic(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): Promise<FridayDeterministicDispatchResult> {
  const { handler } = input.classification;

  switch (handler) {
    case "capabilities":
      return handleCapabilities(input, deps);

    case "task_status":
      return handleTaskStatus(input, deps);

    case "daemon_status":
      return handleDaemonStatus(deps);

    case "mcp_list":
      return handleMcpList(deps);

    case "approval_decision":
      return handleApprovalDecision(input, deps);

    case "workflow_query":
      return handleWorkflowQuery(input, deps);

    case "setup_guidance":
      return handleSetupGuidance(input, deps);

    case "last_user_message":
      return handleLastUserMessage(input, deps);

    case "unsafe_automation_boundary":
      return handleUnsafeAutomationBoundary(input);

    default:
      return { handled: false };
  }
}

// ─── Handlers ───

async function handleCapabilities(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): Promise<FridayDeterministicDispatchResult> {
  if (!deps.capabilitySnapshotGetter) {
    return { handled: false };
  }
  try {
    const snap = await deps.capabilitySnapshotGetter({ readOnly: false });
    const isChinese = containsChinese(input.task ?? "");
    if (isChinese) {
      const lines: string[] = ["当前能力："];

      lines.push(`  只读模式：${snap.readOnly ? "是" : "否"}`);
      lines.push(`  消息渠道：${snap.messaging.enabled ? `已启用（${snap.messaging.kinds.join("、")}）` : "未启用"}`);
      lines.push(`  MCP：${snap.mcp.enabled ? `已启用（${String(snap.mcp.serverCount)} 个 server）` : "未启用"}`);
      if (snap.mcp.servers.length > 0) {
        lines.push(
          `  MCP servers：${snap.mcp.servers
            .map((server) => `${server.name}（${server.connected ? "已连接" : "未连接"}，${server.authenticated ? "已认证" : "未认证"}）`)
            .join("；")}`,
        );
      }
      lines.push(`  Provider：${snap.provider.available ? `可用（已配置 ${String(snap.provider.configuredCount)} 个）` : "不可用"}`);
      if (snap.runtime) {
        lines.push(
          `  已验证能力：${String(snap.runtime.summary.available)} 个可用，${String(snap.runtime.summary.needsVerification)} 个需要验证，${String(snap.runtime.summary.needsUserAction)} 个需要你配置，${String(snap.runtime.summary.installable)} 个可在批准后安装或生成。`,
        );
        for (const item of snap.runtime.items) {
          const sourceSummary = item.sources.length > 0
            ? item.sources.slice(0, 2).map((source) => source.label).join("；")
            : item.blockers[0] ?? "没有来源";
          const repair = item.repairOptions[0];
          const repairSummary = repair
            ? `；修复：${repair.label}${repair.setupHref ? `，入口 ${repair.setupHref}` : repair.href ? `，入口 ${repair.href}` : ""}`
            : "";
          lines.push(`  - ${item.capability}: ${item.state}（${sourceSummary}${repairSummary}）`);
        }
      }
      if (snap.browser.activeMode) {
        lines.push(`  浏览器：${snap.browser.activeMode}${snap.browser.targetBrowser ? `（${snap.browser.targetBrowser}）` : ""}`);
      }
      lines.push(`  系统编排：${snap.system.enabled ? "已启用" : "未启用"}`);
      lines.push(`  桌面 companion：${snap.desktop.connected ? "已连接" : "未连接"}`);

      return { handled: true, response: lines.join("\n") };
    }

    const lines: string[] = ["Current capabilities:"];

    lines.push(`  Read-only mode: ${snap.readOnly ? "yes" : "no"}`);
    lines.push(`  Messaging: ${snap.messaging.enabled ? `enabled (${snap.messaging.kinds.join(", ")})` : "disabled"}`);
    lines.push(`  MCP: ${snap.mcp.enabled ? `enabled (${String(snap.mcp.serverCount)} server(s))` : "disabled"}`);
    if (snap.mcp.servers.length > 0) {
      lines.push(
        `  MCP servers: ${snap.mcp.servers
          .map((server) => `${server.name} (${server.connected ? "connected" : "disconnected"}, ${server.authenticated ? "authenticated" : "unauthenticated"})`)
          .join("; ")}`,
      );
    }
    lines.push(`  Provider: ${snap.provider.available ? `available (${String(snap.provider.configuredCount)} configured)` : "not available"}`);
    if (snap.runtime) {
      lines.push(
        `  Verified capabilities: ${String(snap.runtime.summary.available)} available, ${String(snap.runtime.summary.needsVerification)} need verification, ${String(snap.runtime.summary.needsUserAction)} need user configuration, ${String(snap.runtime.summary.installable)} installable/buildable with approval.`,
      );
      for (const item of snap.runtime.items) {
        const sourceSummary = item.sources.length > 0
          ? item.sources.slice(0, 2).map((source) => source.label).join("; ")
          : item.blockers[0] ?? "no source";
        const repair = item.repairOptions[0];
        const repairSummary = repair
          ? `; fix: ${repair.label}${repair.setupHref ? ` via ${repair.setupHref}` : repair.href ? ` via ${repair.href}` : ""}`
          : "";
        lines.push(`  - ${item.capability}: ${item.state} (${sourceSummary}${repairSummary})`);
      }
    }
    if (snap.browser.activeMode) {
      lines.push(`  Browser: ${snap.browser.activeMode}${snap.browser.targetBrowser ? ` (${snap.browser.targetBrowser})` : ""}`);
    }
    lines.push(`  System orchestration: ${snap.system.enabled ? "enabled" : "disabled"}`);
    lines.push(`  Desktop companion: ${snap.desktop.connected ? "connected" : "disconnected"}`);

    return { handled: true, response: lines.join("\n") };
  } catch (err) {
    console.warn("[friday][deterministic-dispatch] status dispatch failed:", err instanceof Error ? err.message : String(err));
    return { handled: false };
  }
}

async function handleTaskStatus(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): Promise<FridayDeterministicDispatchResult> {
  if (!deps.taskStatusSnapshotGetter) {
    return { handled: false };
  }
  try {
    const snap = await deps.taskStatusSnapshotGetter({
      runId: input.runId,
      sessionKey: input.sessionKey,
      readOnly: false,
    });

    const lines: string[] = [];
    const isChinese = containsChinese(input.task ?? "");

    if (snap.terminalOutcome) {
      lines.push(isChinese
        ? `任务${localizeStatusZh(snap.terminalOutcome.status)}${snap.terminalOutcome.summary ? `：${snap.terminalOutcome.summary}` : ""}`
        : `Task ${snap.terminalOutcome.status}${snap.terminalOutcome.summary ? `: ${snap.terminalOutcome.summary}` : ""}`);
      if (snap.terminalOutcome.responseText) {
        lines.push(snap.terminalOutcome.responseText);
      }
    } else if (snap.runStatus) {
      lines.push(isChinese
        ? `任务状态：${localizeStatusZh(snap.runStatus)}${snap.phase ? `（${localizeStatusZh(snap.phase)}）` : ""}`
        : `Task status: ${snap.runStatus}${snap.phase ? ` (${snap.phase})` : ""}`);
      if (snap.task) {
        lines.push(isChinese ? `任务：${snap.task}` : `Task: ${snap.task}`);
      }
      if (snap.latestTool) {
        lines.push(isChinese ? `最近工具：${snap.latestTool}` : `Latest tool: ${snap.latestTool}`);
      }
      if (typeof snap.elapsedMs === "number") {
        lines.push(isChinese
          ? `已运行：${formatDurationZh(snap.elapsedMs)}`
          : `Elapsed: ${String(Math.round(snap.elapsedMs / 1000))}s`);
      }
      if (snap.blockers.length > 0) {
        lines.push(isChinese ? `阻塞项：${snap.blockers.join("、")}` : `Blockers: ${snap.blockers.join(", ")}`);
      }
      if (snap.activeSubagents.length > 0) {
        lines.push(isChinese ? `活跃子任务：${String(snap.activeSubagents.length)}` : `Active subagents: ${String(snap.activeSubagents.length)}`);
      }
    } else {
      lines.push(isChinese ? "当前没有正在运行的任务。" : "No active task at this time.");
    }

    return { handled: true, response: lines.join("\n") };
  } catch (err) {
    console.warn("[friday][deterministic-dispatch] task status failed:", err instanceof Error ? err.message : String(err));
    return { handled: false };
  }
}

async function handleLastUserMessage(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): Promise<FridayDeterministicDispatchResult> {
  const isChinese = containsChinese(input.task ?? "");
  if (!input.sessionKey || !deps.sessionMessageGetter) {
    return {
      handled: true,
      response: isChinese
        ? "我现在拿不到这个会话的上一条消息。"
        : "I cannot access the previous message for this session right now.",
    };
  }

  const records = await Promise.resolve(deps.sessionMessageGetter(input.sessionKey, 50));
  const previousUserMessage = [...records]
    .filter((record) =>
      record.role === "user"
      && record.contentText.trim().length > 0
      && (
        typeof input.currentUserSequence !== "number"
        || record.sequence < input.currentUserSequence
      ))
    .reverse()[0];

  if (!previousUserMessage) {
    return {
      handled: true,
      response: isChinese
        ? "我没找到你上一条消息。"
        : "I could not find your previous message.",
    };
  }

  const content = previousUserMessage.contentText.trim();
  return {
    handled: true,
    response: isChinese
      ? `你上次问的是：${content}`
      : `You last wrote: ${content}`,
  };
}

function handleUnsafeAutomationBoundary(
  input: DispatchDeterministicInput,
): FridayDeterministicDispatchResult {
  const isChinese = containsChinese(input.task ?? "");
  return {
    handled: true,
    response: isChinese
      ? [
          "这部分我不能做：不能帮你写用于规避检测、防封、绕过反爬或降低被平台发现概率的爬取 skill。",
          "可以做合规版本：基于官方接口、账号可导出的数据、你提供的链接/文件，或低频读取你有权访问的公开内容，并遵守平台规则。",
        ].join("\n")
      : [
          "I cannot help build scraping automation designed to evade detection, avoid bans, bypass anti-bot systems, or reduce the chance of a platform noticing it.",
          "I can help with a compliant version based on official APIs, account exports, user-provided links/files, or low-rate reads of content you are allowed to access under the platform rules.",
        ].join("\n"),
  };
}

function handleDaemonStatus(
  deps: FridayDeterministicDispatchDeps,
): FridayDeterministicDispatchResult {
  if (!deps.getDaemonStatus) {
    return { handled: false };
  }
  return { handled: true, response: formatFridayDaemonStatus(deps.getDaemonStatus()) };
}

function handleMcpList(
  deps: FridayDeterministicDispatchDeps,
): FridayDeterministicDispatchResult {
  if (!deps.listMcpServers) {
    return { handled: false };
  }

  const servers = deps.listMcpServers();
  if (servers.length === 0) {
    return { handled: true, response: "No MCP servers configured." };
  }

  const lines = [`${String(servers.length)} MCP server(s) configured:`];
  for (const server of servers) {
    lines.push(`  - ${server.id}${server.transport ? ` (${server.transport})` : ""}`);
  }
  return { handled: true, response: lines.join("\n") };
}

function handleSetupGuidance(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): FridayDeterministicDispatchResult {
  const targetService = input.classification.extractedParams?.setupTargetService;
  if (!targetService) {
    return { handled: false };
  }

  const recipe = deps.setupRecipeRegistry?.getByTarget(targetService) ?? defaultSetupRecipe(targetService);
  const isChinese = containsChinese(input.task ?? "");
  const locale = isChinese ? "zh" : "en";
  const label = serviceLabel(targetService, locale);
  const setupHref = setupHrefForService(targetService, recipe);
  const targetKind = setupTargetKind(targetService, recipe);
  const outputSummary = recipe?.outputs.map((output) => output.label).join(isChinese ? "、" : ", ");

  if (isChinese) {
    const opening = targetKind === "channel"
      ? `可以。${label} 现在不是“已注册渠道”，所以不能用 message 工具直接绑定或发送；正确路径是走 setup 配置。`
      : targetKind === "provider"
        ? `可以。${label} 现在没有完成可验证的提供方配置；正确路径是走 provider setup、保存凭据和模型后再运行验证。`
        : `可以。${label} 现在需要走能力闭环：先确认来源，再配置或安装，再运行验证；没有验证通过前不能标记为可用。`;
    const lines = [
      opening,
      "",
      recipe
        ? `我找到的配置路径是 \`${recipe.id}\`（${label}）。它会处理：${outputSummary || "配置步骤和验证检查"}。`
        : "当前没有找到完整 recipe，但可以先打开设置页查看现有配置入口和缺口。",
      "你需要准备的最小信息：",
      ...setupInputsForService(targetService, locale).map((item, index) => `${String(index + 1)}. ${item}`),
      "",
      targetKind === "capability"
        ? `下一步：打开 ${label} 设置。Friday 会自动使用已经验证过的来源；如果需要 API key、OAuth、安装依赖、下载第三方包、生成本地工具或写配置，会先暂停等你批准。配完后必须跑一次验证，验证通过才算真正打开。设置入口：${setupHref}`
        : `下一步：打开设置页，选择并展开对应配置，填入凭据后保存。涉及创建应用、重置 token、写入配置这类步骤时应先经过明确批准。设置入口：${setupHref}`,
    ];
    return { handled: true, response: lines.join("\n") };
  }

  const opening = targetKind === "channel"
    ? `Yes. ${label} is not a registered running channel yet, so the message tool cannot bind or send through it directly. The right path is setup configuration.`
    : targetKind === "provider"
      ? `Yes. ${label} has not completed verified provider setup yet. The right path is provider setup, saved credentials/models, and validation.`
      : `Yes. ${label} needs the capability setup loop: choose a source, configure or install it, then verify it before Friday marks it available.`;
  const lines = [
    opening,
    "",
    recipe
      ? `Detected setup path: \`${recipe.id}\` (${recipe.name}). It handles: ${outputSummary || "configuration steps and verification checks"}.`
      : "No complete recipe is registered for this service, but Settings can still show the current configuration entry points and blockers.",
    "Minimum information needed:",
    ...setupInputsForService(targetService, locale).map((item, index) => `${String(index + 1)}. ${item}`),
    "",
    targetKind === "capability"
      ? `Next step: open ${label} setup. Friday will automatically use verified sources; API keys, OAuth, dependency installs, third-party downloads, generated local tools, and config writes must pause for approval. After setup, run a verification probe before marking it available. Setup: ${setupHref}`
      : `Next step: open Settings, select and expand the target config, enter credentials, then save. Creating apps, resetting tokens, or writing config should remain approval-gated. Setup: ${setupHref}`,
  ];
  return { handled: true, response: lines.join("\n") };
}

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

function localizeStatusZh(status: string): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
    case "executing":
      return "执行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "pending":
      return "等待中";
    case "planning":
      return "规划中";
    case "testing":
      return "验证中";
    case "fixing":
      return "修复中";
    default:
      return status;
  }
}

function formatDurationZh(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.round(valueMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

function serviceLabel(service: string, locale: "zh" | "en" = "en"): string {
  if (locale === "zh") {
    switch (service) {
      case "anthropic":
        return "Claude/Anthropic";
      case "qwen":
        return "通义千问 Qwen";
      case "deepseek":
        return "DeepSeek";
      case "openai":
        return "OpenAI";
      case "google":
        return "Gemini/Google";
      case "volcengine":
        return "火山/豆包";
      case "moonshot":
        return "月之暗面/Kimi";
      case "glm":
        return "智谱 GLM";
      case "qianfan":
        return "百度千帆";
      case "minimax":
        return "MiniMax";
      case "text":
        return "文本模型";
      case "vision":
        return "看图 / 图片理解";
      case "ocr":
        return "OCR 文字识别";
      case "embedding":
        return "Embedding 记忆检索";
      case "web_search":
        return "网页搜索";
      case "pdf_parse":
        return "PDF 解析";
      case "tts":
        return "TTS 语音";
      case "browser":
        return "浏览器";
      case "mcp":
        return "MCP";
      case "skills":
        return "Skills 技能";
      case "custom":
        return "自定义能力";
      default:
        return service;
    }
  }
  switch (service) {
    case "anthropic":
      return "Claude/Anthropic";
    case "qwen":
      return "Qwen";
    case "deepseek":
      return "DeepSeek";
    case "openai":
      return "OpenAI";
    case "google":
      return "Gemini/Google";
    case "volcengine":
      return "Volcengine/Doubao";
    case "moonshot":
      return "Moonshot/Kimi";
    case "glm":
      return "Zhipu GLM";
    case "qianfan":
      return "Baidu Qianfan";
    case "minimax":
      return "MiniMax";
    case "text":
      return "Text generation";
    case "vision":
      return "Vision";
    case "ocr":
      return "OCR";
    case "embedding":
      return "Embeddings";
    case "web_search":
      return "Web search";
    case "pdf_parse":
      return "PDF parsing";
    case "tts":
      return "TTS";
    case "browser":
      return "Browser";
    case "mcp":
      return "MCP";
    case "skills":
      return "Skills";
    case "custom":
      return "Custom capability";
    default:
      return service.replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function setupHrefForService(service: string, recipe: FridaySetupRecipe | null): string {
  if (recipe?.category === "provider" || isProviderService(service)) {
    return `/setup?step=provider&providerKind=${encodeURIComponent(service)}${recipe ? `&recipeId=${encodeURIComponent(recipe.id)}` : ""}`;
  }
  if (recipe?.category === "integration" || isCapabilityService(service)) {
    return `/setup?recipeId=${encodeURIComponent(recipe?.id ?? `capability-${service}`)}&targetService=${encodeURIComponent(service)}`;
  }
  return `/setup?step=channels&channel=${encodeURIComponent(service)}${recipe ? `&recipeId=${encodeURIComponent(recipe.id)}` : ""}`;
}

function setupTargetKind(service: string, recipe: FridaySetupRecipe | null): "provider" | "channel" | "capability" {
  if (recipe?.category === "provider" || isProviderService(service)) {
    return "provider";
  }
  if (recipe?.category === "integration" || isCapabilityService(service)) {
    return "capability";
  }
  return "channel";
}

function isProviderService(service: string): boolean {
  return [
    "openai",
    "anthropic",
    "google",
    "volcengine",
    "qwen",
    "deepseek",
    "moonshot",
    "glm",
    "qianfan",
    "minimax",
  ].includes(service);
}

function isCapabilityService(service: string): boolean {
  return [
    "text",
    "vision",
    "ocr",
    "embedding",
    "web_search",
    "pdf_parse",
    "tts",
    "browser",
    "mcp",
    "skills",
    "custom",
  ].includes(service);
}

function setupInputsForService(service: string, locale: "zh" | "en" = "en"): string[] {
  if (locale === "zh") {
    switch (service) {
      case "discord":
        return ["Discord Bot Token", "如果要绑定固定服务器，需要 Guild/server ID", "允许创建或复用 bot，并邀请它读取和发送消息"];
      case "telegram":
        return ["BotFather bot token", "如果需要主动发消息，需要目标私聊或群组信息"];
      case "slack":
        return ["Slack bot token", "如果使用 Socket Mode，需要 app token", "工作区和频道权限批准"];
      case "whatsapp":
        return ["WhatsApp Business access token", "Phone Number ID", "如果接收消息，需要 webhook verify token"];
      case "qq":
        return ["QQ bot App ID", "QQ bot App Secret"];
      case "lark":
      case "feishu":
        return ["用手机扫码授权创建应用", "允许 Friday 给你发私聊验证消息", "保存后 Friday 会用长连接接收消息，不需要公网回调地址"];
      case "line":
        return ["Channel access token", "Channel secret"];
      case "signal":
        return ["Signal CLI API URL", "手机号"];
      case "irc":
        return ["IRC server", "Nickname", "Channel list", "如有需要再提供密码"];
      case "text":
        return ["一个可用的文本模型账号/API key，或本地模型 endpoint", "模型 ID", "文本验证任务通过"];
      case "vision":
        return ["一个支持图片输入的模型来源，比如 Gemini、Qwen-VL、豆包视觉，或本地视觉 endpoint", "要使用的视觉模型 ID", "用样例图片跑一次理解验证"];
      case "ocr":
        return ["OCR 服务账号/API key，或批准生成/安装本地 OCR 工具", "一张包含文字的样例图片", "OCR 验证能返回预期文字"];
      case "embedding":
        return ["Embedding 服务账号/API key，或本地 embedding endpoint", "Embedding 模型 ID", "向量验证能返回非空数字向量"];
      case "web_search":
        return ["Serper、Tavily 或其他搜索提供方 API key", "选择搜索提供方", "搜索验证能返回真实且有时效的结果"];
      case "pdf_parse":
        return ["工作区里的样例 PDF", "如果内置解析不可用，需要批准安装/生成解析工具"];
      case "tts":
        return ["语音/TTS 服务 API key", "语音模型和声音", "短音频合成验证能生成非空文件"];
      case "browser":
        return ["Playwright Chromium 或宿主浏览器可用", "允许启动浏览器自动化", "导航和截图验证通过"];
      case "mcp":
        return ["可信 MCP server 命令或 URL", "必要的环境密钥", "权限审查通过后再做 discovery/list_tools 验证"];
      case "skills":
        return ["可信 skill 来源、市场条目、Git URL 或生成目标", "安装/生成前先批准", "刷新 registry，必要时跑 smoke test"];
      case "custom":
        return ["明确目标和预期输出", "选择路径：内置工具、生成 skill/tool、provider 或 MCP", "一个能证明能力可用的代表性测试"];
      default:
        return ["账号/API 凭据", "目标工作区、服务器或频道", "写配置前的权限批准"];
    }
  }
  switch (service) {
    case "discord":
      return [
        "Discord Bot Token",
        "Guild/server ID if you want to bind a specific server",
        "Approval to create or reuse the bot app and invite it with message permissions",
      ];
    case "telegram":
      return ["BotFather bot token", "Target chat/group details if Friday should send proactively"];
    case "slack":
      return ["Slack bot token", "Socket Mode app token if used", "Workspace/channel permission approval"];
    case "whatsapp":
      return ["WhatsApp Business access token", "Phone Number ID", "Webhook verify token if receiving messages"];
    case "qq":
      return ["QQ bot App ID", "QQ bot App Secret"];
    case "lark":
    case "feishu":
      return ["App ID", "App Secret", "Tenant/workspace permission approval"];
    case "line":
      return ["Channel access token", "Channel secret"];
    case "signal":
      return ["Signal CLI API URL", "Phone number"];
    case "irc":
      return ["IRC server", "Nickname", "Channel list", "Password if required"];
    case "text":
      return ["A supported text provider account/API key or local model endpoint", "Model ID", "Capability doctor text probe passing"];
    case "vision":
      return ["A multimodal provider/API key or local vision endpoint", "Vision-capable model ID", "Sample image-understanding probe passing"];
    case "ocr":
      return ["OCR provider/API key or approval to generate/install a local OCR tool", "Sample image containing text", "OCR probe returning expected text"];
    case "embedding":
      return ["Embedding provider/API key or local embedding endpoint", "Embedding model ID", "Vector probe returning a non-empty numeric vector"];
    case "web_search":
      return ["Serper or Tavily API key, or an approved search provider", "Provider selection", "Freshness/search probe returning real results"];
    case "pdf_parse":
      return ["A sample PDF inside the workspace", "Approval for parser dependency/tool installation if the built-in parser is unavailable"];
    case "tts":
      return ["Speech/TTS provider API key", "Speech model and voice", "Short audio synthesis probe writing a non-empty file"];
    case "browser":
      return ["Playwright Chromium or host browser availability", "Permission to launch browser automation", "Navigation/snapshot probe passing"];
    case "mcp":
      return ["Trusted MCP server command or URL", "Required environment secrets", "Permission review plus discovery/list_tools verification"];
    case "skills":
      return ["Trusted skill source, marketplace listing, Git URL, or generation goal", "Installation/generation approval", "Registry refresh and optional smoke test"];
    case "custom":
      return ["Exact user goal and expected output", "Chosen path: built-in tool, generated skill/tool, provider, or MCP", "Representative test that proves the capability works"];
    default:
      return ["Account/API credential", "Target workspace/server/channel if applicable", "Permission approval for config writes"];
  }
}

function defaultSetupRecipe(service: string): FridaySetupRecipe | null {
  const idByService: Record<string, string> = {
    discord: "channel-discord-bot",
    telegram: "channel-telegram-bot",
    slack: "channel-slack-app",
    openai: "provider-openai",
    anthropic: "provider-anthropic",
    google: "provider-google",
    volcengine: "provider-volcengine",
    qwen: "provider-qwen",
    deepseek: "provider-deepseek",
    moonshot: "provider-moonshot",
    glm: "provider-glm",
    qianfan: "provider-qianfan",
    minimax: "provider-minimax",
    text: "capability-text",
    vision: "capability-vision",
    ocr: "capability-ocr",
    embedding: "capability-embedding",
    web_search: "capability-web-search",
    pdf_parse: "capability-pdf-parse",
    tts: "capability-tts",
    browser: "capability-browser",
    mcp: "capability-mcp",
    skills: "capability-skills",
    custom: "capability-custom",
  };
  const id = idByService[service];
  if (!id) {
    return null;
  }
  const category = id.startsWith("provider-")
    ? "provider"
    : id.startsWith("channel-")
      ? "channel"
      : "integration";
  return {
    id,
    name: `${serviceLabel(service)} Setup`,
    description: `Configure ${serviceLabel(service)} for Friday.`,
    category,
    version: "1.0.0",
    targetService: service,
    prerequisites: [],
    steps: [],
    outputs: [],
  };
}

async function handleApprovalDecision(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): Promise<FridayDeterministicDispatchResult> {
  const decision = input.classification.extractedParams?.decision;
  if (!decision || !deps.approvalService) {
    return { handled: false };
  }

  const actorId = input.actorId ?? "system";
  const explicitApprovalId = input.classification.extractedParams?.approvalId;

  if (explicitApprovalId) {
    return executeApprovalDecision({
      approvalId: explicitApprovalId,
      decision,
      actorId,
      approvalService: deps.approvalService,
    });
  }

  const pending = deps.approvalService.listPending({});
  if (pending.length === 0) {
    return { handled: true, response: "No pending approvals at this time." };
  }
  if (pending.length > 1) {
    const lines = [
      `Multiple pending approvals require clarification before ${decision}:`,
    ];
    for (const approval of pending) {
      lines.push(`  - ${approval.id} (run ${approval.runId}, node ${approval.nodeId})`);
    }
    return { handled: true, response: lines.join("\n") };
  }

  return executeApprovalDecision({
    approvalId: pending[0]!.id,
    decision,
    actorId,
    approvalService: deps.approvalService,
  });
}

async function executeApprovalDecision(input: {
  approvalId: string;
  decision: "approve" | "reject";
  actorId: string;
  approvalService: FridayWorkflowApprovalService;
}): Promise<FridayDeterministicDispatchResult> {
  try {
    const result = input.decision === "approve"
      ? await input.approvalService.approve({
          approvalId: input.approvalId,
          decidedByUserId: input.actorId,
          comment: undefined,
        })
      : await input.approvalService.reject({
          approvalId: input.approvalId,
          decidedByUserId: input.actorId,
          comment: undefined,
        });
    const action = input.decision === "approve" ? "Approved" : "Rejected";
    return {
      handled: true,
      response: `${action} approval ${result.approval.id} for workflow run ${result.approval.runId}. Resumed: ${result.resumed ? "yes" : "no"}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      response: `Unable to ${input.decision} approval ${input.approvalId}: ${message}`,
    };
  }
}

function handleWorkflowQuery(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): FridayDeterministicDispatchResult {
  if (!deps.workflowExecutionService) {
    return { handled: false };
  }

  const explicitRunId = input.classification.extractedParams?.runId;
  if (explicitRunId) {
    const run = deps.workflowExecutionService.getRun(explicitRunId);
    if (!run) {
      return { handled: true, response: `Workflow run ${explicitRunId} not found.` };
    }
    return { handled: true, response: formatWorkflowRunDetail(run) };
  }

  const activeRuns = deps.workflowExecutionService.listActiveRuns(10);
  if (activeRuns.length === 0) {
    return { handled: true, response: "No active workflow runs." };
  }

  const lines = [`${String(activeRuns.length)} active workflow run(s):`];
  for (const run of activeRuns) {
    lines.push(`  - ${run.id} (${run.status}) workflow ${run.workflowId}`);
  }
  return { handled: true, response: lines.join("\n") };
}

function formatWorkflowRunDetail(run: FridayWorkflowRunEntity): string {
  const lines = [
    `Workflow run ${run.id}: ${run.status}`,
    `Workflow: ${run.workflowId}`,
    `Started: ${run.startedAt}`,
  ];
  if (run.finishedAt) {
    lines.push(`Finished: ${run.finishedAt}`);
  }
  if (run.failure) {
    lines.push(`Failure: ${run.failure.code} — ${run.failure.message}`);
  }
  return lines.join("\n");
}
