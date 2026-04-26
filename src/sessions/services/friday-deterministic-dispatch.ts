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

// ─── Types ───

export interface FridayDeterministicDispatchResult {
  readonly handled: boolean;
  readonly response?: string;
}

export interface FridayDeterministicDispatchDeps {
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
}

// ─── Dispatch ───

export async function dispatchDeterministic(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): Promise<FridayDeterministicDispatchResult> {
  const { handler } = input.classification;

  switch (handler) {
    case "capabilities":
      return handleCapabilities(deps);

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

    default:
      return { handled: false };
  }
}

// ─── Handlers ───

async function handleCapabilities(
  deps: FridayDeterministicDispatchDeps,
): Promise<FridayDeterministicDispatchResult> {
  if (!deps.capabilitySnapshotGetter) {
    return { handled: false };
  }
  try {
    const snap = await deps.capabilitySnapshotGetter({ readOnly: false });
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

    if (snap.terminalOutcome) {
      lines.push(`Task ${snap.terminalOutcome.status}${snap.terminalOutcome.summary ? `: ${snap.terminalOutcome.summary}` : ""}`);
      if (snap.terminalOutcome.responseText) {
        lines.push(snap.terminalOutcome.responseText);
      }
    } else if (snap.runStatus) {
      lines.push(`Task status: ${snap.runStatus}${snap.phase ? ` (${snap.phase})` : ""}`);
      if (snap.task) {
        lines.push(`Task: ${snap.task}`);
      }
      if (snap.latestTool) {
        lines.push(`Latest tool: ${snap.latestTool}`);
      }
      if (typeof snap.elapsedMs === "number") {
        lines.push(`Elapsed: ${String(Math.round(snap.elapsedMs / 1000))}s`);
      }
      if (snap.blockers.length > 0) {
        lines.push(`Blockers: ${snap.blockers.join(", ")}`);
      }
      if (snap.activeSubagents.length > 0) {
        lines.push(`Active subagents: ${String(snap.activeSubagents.length)}`);
      }
    } else {
      lines.push("No active task at this time.");
    }

    return { handled: true, response: lines.join("\n") };
  } catch (err) {
    console.warn("[friday][deterministic-dispatch] task status failed:", err instanceof Error ? err.message : String(err));
    return { handled: false };
  }
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
  const label = serviceLabel(targetService);
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
        ? `我找到的配置路径是 \`${recipe.id}\`（${recipe.name}）。它会处理：${outputSummary || "配置步骤和验证检查"}。`
        : "当前没有找到完整 recipe，但可以先打开设置页查看现有配置入口和缺口。",
      "你需要准备的最小信息：",
      ...setupInputsForService(targetService).map((item, index) => `${String(index + 1)}. ${item}`),
      "",
      targetKind === "capability"
        ? "下一步：打开能力配置路径或执行对应 recipe。涉及 API key、OAuth、安装依赖、下载第三方包、生成本地工具、写入配置时会先暂停等待确认；配完后必须运行 doctor 或代表性任务验证。"
        : "下一步：打开设置页，选择并展开对应配置，填入凭据后保存。涉及创建应用、重置 token、写入配置这类步骤时应先经过明确批准。",
      `<!--action:{"type":"open_page","label":"打开 ${label} 设置","href":"${setupHref}"}-->`,
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
    ...setupInputsForService(targetService).map((item, index) => `${String(index + 1)}. ${item}`),
    "",
    targetKind === "capability"
      ? "Next step: open the capability setup path or execute the recipe. API keys, OAuth, dependency installs, third-party downloads, generated local tools, and config writes must pause for approval; after setup, run doctor or a representative task."
      : "Next step: open Settings, select and expand the target config, enter credentials, then save. Creating apps, resetting tokens, or writing config should remain approval-gated.",
    `<!--action:{"type":"open_page","label":"Open ${label} Setup","href":"${setupHref}"}-->`,
  ];
  return { handled: true, response: lines.join("\n") };
}

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

function serviceLabel(service: string): string {
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

function setupInputsForService(service: string): string[] {
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
