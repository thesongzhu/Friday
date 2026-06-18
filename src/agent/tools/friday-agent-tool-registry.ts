import type { FridaySkillExecutor, FridaySkillRegistry, SkillLifecycleStatus } from "#skills";
import type { FridayWorkflowCrudService, FridayWorkflowExecutionService } from "#workflows";
import type { FridayMemoryGuardServiceFactory, FridayMemoryService } from "#memory";
import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import type { FridayAgentSsrfGuard } from "../security/friday-agent-ssrf-guard.js";
import type { FridaySubagentContext, FridaySubagentRegistry } from "../subagent/friday-subagent.types.js";
import type { FridayBrowserManager } from "../../browser/friday-browser-manager.js";
import { createFridayAgentExecTool } from "./friday-agent-exec-tool.js";
import { createFridayAgentFileTools } from "./friday-agent-file-tools.js";
import { createFridayAgentWebFetchTool } from "./friday-agent-web-fetch-tool.js";
import { createFridayAgentWebSearchTool } from "./friday-agent-web-search-tool.js";
import { createFridayAgentSkillTool } from "./friday-agent-skill-tool.js";
import { createFridayAgentSkillsListTool } from "./friday-agent-skills-list-tool.js";
import {
  createFridayAgentWorkflowListTool,
  createFridayAgentWorkflowTool,
} from "./friday-agent-workflow-tool.js";
import { createFridayAgentMemoryTools } from "./friday-agent-memory-tools.js";
import { createFridayAgentSubagentTools } from "./friday-agent-subagent-tools.js";
import { createFridayAgentBrowserTool } from "./friday-agent-browser-tool.js";
import { createFridayAgentXhsTool } from "./friday-agent-xhs-tool.js";
import { createFridayAgentImageAnalysisTool } from "./friday-agent-image-analysis-tool.js";
import { createFridayAgentTtsTool } from "./friday-agent-tts-tool.js";
import { createFridayAgentPdfParseTool } from "./friday-agent-pdf-parse-tool.js";
import { createFridayAgentCanvasTool } from "./friday-agent-canvas-tool.js";
import { createFridayAgentNodesTool } from "./friday-agent-nodes-tool.js";
import { createFridayAgentGatewayTool } from "./friday-agent-gateway-tool.js";
import { createFridayAgentCronTool } from "./friday-agent-cron-tool.js";
import { createFridayAgentMessageTool } from "./friday-agent-message-tool.js";
import { createFridayAgentAgentsListTool } from "./friday-agent-agents-list-tool.js";
import { createFridayAgentSessionsTool } from "./friday-agent-sessions-tool.js";
import { createFridayAgentMcpTool, type FridayMcpServerAvailabilityResolver } from "./friday-agent-mcp-tool.js";
import type { FridayImageAnalysisFn } from "./friday-agent-image-analysis-tool.js";
import type { FridayTtsService } from "../../media/friday-tts-service.js";
import type { FridayNodesService } from "../../nodes/friday-nodes-service.js";
import type { FridayGatewayService } from "../../hub/services/friday-gateway-service.js";
import type { FridayChannelRegistry } from "../../channels/friday-channel-registry.js";
import type { FridayJobSchedulerRepository } from "../../jobs/scheduler/friday-job-scheduler-repository.js";
import type { FridayJobSchedulerService } from "../../jobs/scheduler/friday-job-scheduler.types.js";
import type { FridaySessionService } from "../../sessions/services/friday-session-service.types.js";
import type { FridayAgentRuntime } from "../runtime/friday-agent-runtime.types.js";
import type { XhsPageInteractions } from "../../xhs/friday-xhs-pages.js";
import type { XhsSessionManager } from "../../xhs/friday-xhs-session.js";
import type { DesktopSessionManager } from "../../desktop/engine/session-manager.js";
import { createFridayAgentDesktopTool } from "./friday-agent-desktop-tool.js";
import type { FridaySystemService } from "../../system/engine/friday-system-service.js";
import { createFridayAgentSystemTool } from "./friday-agent-system-tool.js";
import type { FridayGuideLensService } from "../../guide-lens/model/friday-guide-lens.types.js";
import { createFridayAgentGuideLensTool } from "./friday-agent-guide-lens-tool.js";
import { createFridayAgentMemoryExtractTool } from "./friday-agent-memory-extract-tool.js";
import type { FridayMcpAdapter } from "../mcp/friday-mcp-adapter.types.js";
import { listFridayMcpServerReadiness } from "../mcp/friday-mcp-readiness.js";
import type { FridaySessionMemoryExtractionService } from "#sessions";
import type { FridayProviderService } from "../../providers/services/friday-provider-service.types.js";
import { createFridayAgentProviderTool } from "./friday-agent-provider-tool.js";
import type { FridayLearnedFactView } from "../../learning/services/friday-learned-fact-memory-view.js";
import type { FridayLearningEventAppendInput } from "#ledger";
import type { FridayReflexService } from "../../reflex/index.js";
import {
  createFridayAgentCapabilitiesTool,
  type FridayAgentCapabilitiesSnapshot,
} from "./friday-agent-capabilities-tool.js";
import {
  createFridayAgentTaskStatusTool,
  type FridayAgentTaskStatusSnapshot,
} from "./friday-agent-task-status-tool.js";
import type { FridayOperationalMode } from "../runtime/friday-agent-operational-mode.js";
import { filterToolsByMode } from "../runtime/friday-agent-operational-mode.js";
import { createFridayAgentReflexTools } from "./friday-agent-reflex-tools.js";

// ─── Registry options ───

export interface CreateFridayAgentToolRegistryOptions {
  workdir?: string;
  skillExecutor?: FridaySkillExecutor;
  skillRegistry?: FridaySkillRegistry;
  getSkillLifecycleStatus?: (skillId: string) => SkillLifecycleStatus | null | undefined;
  /**
   * TS Runtime Retirement — OF6 method-level guard for the agent `skill_run`
   * tool (a NON-route caller of the arbitrary-code skill sink). Threaded into
   * the skill tool's deps; default-undefined → OFF → fail-closed. Same flag as
   * the skill route. See createFridayAgentSkillTool for the exemption details.
   */
  allowTestOnlySkillRunExecution?: boolean;
  workflowCrudService?: FridayWorkflowCrudService;
  workflowExecutionService?: FridayWorkflowExecutionService;
  memoryService?: FridayMemoryService;
  memoryGuardFactory?: FridayMemoryGuardServiceFactory;
  listLearnedFacts?: (input: { userId: string; limit: number }) => FridayLearnedFactView[];
  learningEventWriter?: (events: FridayLearningEventAppendInput[]) => void;
  idGenerator?: () => string;
  nowIso?: () => string;
  subagentRegistry?: FridaySubagentRegistry;
  subagentContext?: FridaySubagentContext;
  browserManager?: FridayBrowserManager;
  /**
   * Test-oracle/descope override only. XHS automation is C1-descope and must
   * not be exposed in the default/live agent tool registry even when bootstrap
   * has legacy XHS deps available.
   */
  allowTestOnlyXhsExecution?: boolean;
  xhsPageInteractions?: XhsPageInteractions;
  xhsSessionManager?: XhsSessionManager;
  /** Optional SSRF guard for web_fetch tool. */
  ssrfGuard?: FridayAgentSsrfGuard;
  /** Image analysis function for image_analysis tool. */
  analyzeImages?: FridayImageAnalysisFn;
  /** TTS service for tts tool. */
  ttsService?: FridayTtsService;
  /** Nodes service for nodes tool. */
  nodesService?: FridayNodesService;
  /** Gateway service for gateway tool. */
  gatewayService?: FridayGatewayService;
  /** Channel registry for message tool. */
  channelRegistry?: FridayChannelRegistry;
  /** Scheduler repository for cron tool. */
  schedulerRepository?: FridayJobSchedulerRepository;
  /** Scheduler service for cron tool. */
  schedulerService?: FridayJobSchedulerService;
  /** Session service for sessions tool. */
  sessionService?: FridaySessionService;
  /** Agent runtime for sessions tool (send action). */
  agentRuntime?: FridayAgentRuntime;
  /**
   * Lazy getter for agent runtime — used when runtime cannot be provided at
   * registry construction time (circular dependency). Takes precedence over
   * `agentRuntime` when both are supplied.
   */
  agentRuntimeGetter?: () => FridayAgentRuntime | undefined;
  /** Desktop session manager for desktop control tool. */
  desktopSessionManager?: DesktopSessionManager;
  /** Agent OS orchestration service for the `system` tool. */
  systemService?: FridaySystemService;
  /** Read-only native guide overlay service for the `guide_lens` tool. */
  guideLensService?: FridayGuideLensService;
  /** Optional MCP adapter for external MCP server integration. */
  mcpAdapter?: FridayMcpAdapter;
  /** Optional lifecycle availability gate for configured MCP servers. */
  getMcpServerAvailability?: FridayMcpServerAvailabilityResolver;
  /** OC-013: Session memory extraction service for memory_extract tool. */
  extractionService?: FridaySessionMemoryExtractionService;
  /** Provider service for LLM provider management tool. */
  providerService?: FridayProviderService;
  /**
   * TS Runtime Retirement — CALLER-scoped guard for the agent `provider` tool's
   * `validate` action (a NON-route caller of the live, billable
   * `validateProvider` probe). Threaded into the provider tool's options;
   * default-undefined → OFF → the validate action fails closed. Same flag as the
   * provider route (`allowTestOnlyProviderProbeExecution`); the SHARED
   * auto-validate routing path is intentionally NOT touched.
   */
  allowTestOnlyProviderProbeExecution?: boolean;
  /** Web search provider: "auto" | "serper" | "tavily" | "duckduckgo" | "google_news_rss". Defaults to "auto". */
  webSearchProvider?: string;
  /** API key for the configured web search provider. */
  webSearchApiKey?: string;
  /** Deterministic runtime capability snapshot getter for the capabilities tool. */
  capabilitySnapshotGetter?: (input: { readOnly: boolean }) =>
    Promise<FridayAgentCapabilitiesSnapshot> | FridayAgentCapabilitiesSnapshot;
  /** Deterministic task status snapshot getter for coordinator/status questions. */
  taskStatusSnapshotGetter?: (input: { runId?: string; sessionKey?: string; readOnly: boolean }) =>
    Promise<FridayAgentTaskStatusSnapshot> | FridayAgentTaskStatusSnapshot;
  /** Reflex service for candidate review and explicit canonical preference updates. */
  reflexService?: FridayReflexService;
  /** Late-bound Reflex service getter for bootstrap order/circular dependency cases. */
  reflexServiceGetter?: () => FridayReflexService | undefined;
  /** Default principal for Reflex tools when a runtime principal is not injected. */
  defaultReflexUserId?: string;
  /** Whether explicit subagent fork mode should be exposed in tool schema. */
  subagentForkModeEnabled?: boolean;
  /** Operational mode — when set, tools are filtered by allowed categories. */
  operationalMode?: FridayOperationalMode;
}

// ─── Factory ───

export function createFridayAgentToolRegistry(
  options?: CreateFridayAgentToolRegistryOptions,
): FridayAgentToolDefinition[] {
  const workdir = options?.workdir ?? process.cwd();
  const listLifecycleAvailableMcpServers = () => {
    if (!options?.mcpAdapter || !options.getMcpServerAvailability) {
      return [];
    }
    return options.mcpAdapter
      .listServers()
      .filter((server) => options.getMcpServerAvailability!(server.id).available);
  };
  const listLifecycleAvailableMcpServerStates = () => {
    if (!options?.mcpAdapter || !options.getMcpServerAvailability) {
      return [];
    }
    const availableIds = new Set(listLifecycleAvailableMcpServers().map((server) => server.id));
    return options.mcpAdapter
      .listServerStates()
      .filter((state) => availableIds.has(state.serverId));
  };
  const listMcpServerReadiness = () => listFridayMcpServerReadiness({
    servers: listLifecycleAvailableMcpServers(),
    serverStates: listLifecycleAvailableMcpServerStates(),
  });

  const tools: FridayAgentToolDefinition[] = [
    createFridayAgentExecTool({ defaultWorkdir: workdir, workspaceRoot: workdir }),
    ...createFridayAgentFileTools({ workspaceRoot: workdir }),
    createFridayAgentWebFetchTool({ ssrfGuard: options?.ssrfGuard }),
    createFridayAgentWebSearchTool({
      provider: options?.webSearchProvider,
      apiKey: options?.webSearchApiKey,
    }),
    createFridayAgentPdfParseTool({ workspaceRoot: workdir }),
  ];

  if (options?.skillExecutor) {
    tools.push(
      ...(options.skillRegistry
        ? [createFridayAgentSkillsListTool({
          skillRegistry: options.skillRegistry,
          listMcpServerReadiness,
          getSkillLifecycleStatus: options.getSkillLifecycleStatus,
        })]
        : []),
      createFridayAgentSkillTool({
        skillExecutor: options.skillExecutor,
        skillRegistry: options.skillRegistry,
        listMcpServerReadiness,
        getSkillLifecycleStatus: options?.getSkillLifecycleStatus,
        allowTestOnlySkillRunExecution: options?.allowTestOnlySkillRunExecution,
      }),
    );
  }

  if (options?.workflowCrudService) {
    tools.push(
      createFridayAgentWorkflowListTool({ workflowCrudService: options.workflowCrudService }),
    );
  }

  if (options?.workflowExecutionService) {
    tools.push(
      createFridayAgentWorkflowTool({ workflowExecutionService: options.workflowExecutionService }),
    );
  }

  if (options?.memoryService) {
    tools.push(
      ...createFridayAgentMemoryTools({
        memoryService: options.memoryService,
        listLearnedFacts: options.listLearnedFacts,
        learningEventWriter: options.learningEventWriter,
        idGenerator: options.idGenerator,
        nowIso: options.nowIso,
        resolveSessionMemoryNamespace: options.sessionService
          ? async (sessionKey) => options.sessionService?.getSessionMemoryNamespace(sessionKey)
          : undefined,
        resolveSessionMemoryNamespaceCandidates: options.sessionService
          ? async (sessionKey) => options.sessionService?.getSessionMemoryNamespaceCandidates(sessionKey)
          : undefined,
        memoryGuardFactory: options.memoryGuardFactory,
      }),
    );
  }

  if (options?.subagentRegistry && options?.subagentContext) {
    tools.push(
      ...createFridayAgentSubagentTools({
        registry: options.subagentRegistry,
        subagentContext: options.subagentContext,
        forkModeEnabled: options.subagentForkModeEnabled,
      }),
    );
  }

  if (options?.browserManager) {
    tools.push(
      createFridayAgentBrowserTool({ browserManager: options.browserManager }),
    );
  }

  if (
    options?.allowTestOnlyXhsExecution === true
    && options.xhsPageInteractions
    && options.xhsSessionManager
  ) {
    tools.push(
      createFridayAgentXhsTool({
        pageInteractions: options.xhsPageInteractions,
        sessionManager: options.xhsSessionManager,
      }),
    );
  }

  // ─── New tools (Task B) ───

  if (options?.analyzeImages) {
    tools.push(
      createFridayAgentImageAnalysisTool({ analyzeImages: options.analyzeImages }),
    );
  }

  if (options?.ttsService) {
    tools.push(
      createFridayAgentTtsTool({ ttsService: options.ttsService }),
    );
  }

  if (options?.browserManager) {
    tools.push(
      createFridayAgentCanvasTool({ browserManager: options.browserManager, workspaceRoot: workdir }),
    );
  }

  if (options?.nodesService) {
    tools.push(
      createFridayAgentNodesTool({ nodesService: options.nodesService }),
    );
  }

  if (options?.gatewayService) {
    tools.push(
      createFridayAgentGatewayTool({ gatewayService: options.gatewayService }),
    );
  }

  if (options?.schedulerRepository && options?.schedulerService) {
    tools.push(
      createFridayAgentCronTool({
        schedulerRepository: options.schedulerRepository,
        schedulerService: options.schedulerService,
      }),
    );
  }

  if (options?.channelRegistry) {
    tools.push(
      createFridayAgentMessageTool({ channelRegistry: options.channelRegistry }),
    );
  }

  if (options?.subagentRegistry) {
    tools.push(
      createFridayAgentAgentsListTool({ subagentRegistry: options.subagentRegistry }),
    );
  }

  if (options?.sessionService && (options?.agentRuntime || options?.agentRuntimeGetter)) {
    tools.push(
      createFridayAgentSessionsTool({
        sessionService: options.sessionService,
        agentRuntime: options.agentRuntime,
        agentRuntimeGetter: options.agentRuntimeGetter,
      }),
    );
  }

  // ─── Desktop control tool (C-002) ───

  if (options?.desktopSessionManager) {
    tools.push(
      createFridayAgentDesktopTool({ desktopSessionManager: options.desktopSessionManager }),
    );
  }

  if (options?.systemService) {
    tools.push(
      createFridayAgentSystemTool({ systemService: options.systemService }),
    );
  }

  if (options?.guideLensService) {
    tools.push(
      createFridayAgentGuideLensTool({ guideLensService: options.guideLensService }),
    );
  }

  // ─── OC-013: Memory extraction tool ───

  if (options?.extractionService) {
    tools.push(
      createFridayAgentMemoryExtractTool({ extractionService: options.extractionService }),
    );
  }

  if (options?.mcpAdapter && options.getMcpServerAvailability && listLifecycleAvailableMcpServers().length > 0) {
    tools.push(
      createFridayAgentMcpTool({
        mcpAdapter: options.mcpAdapter,
        getServerAvailability: options.getMcpServerAvailability,
      }),
    );
  }

  if (options?.providerService) {
    tools.push(
      createFridayAgentProviderTool({
        providerService: options.providerService,
        // CALLER-scoped probe fence: default-OFF unless the test-oracle flag is
        // threaded from bootstrap. The validate action fails closed otherwise.
        allowTestOnlyProviderProbeExecution: options.allowTestOnlyProviderProbeExecution,
      }),
    );
  }

  if (options?.capabilitySnapshotGetter) {
    tools.push(
      createFridayAgentCapabilitiesTool({ getSnapshot: options.capabilitySnapshotGetter }),
    );
  }

  if (options?.taskStatusSnapshotGetter) {
    tools.push(
      createFridayAgentTaskStatusTool({ getSnapshot: options.taskStatusSnapshotGetter }),
    );
  }

  if (options?.reflexService || options?.reflexServiceGetter) {
    tools.push(
      ...createFridayAgentReflexTools({
        reflexService: options.reflexService,
        reflexServiceGetter: options.reflexServiceGetter,
        defaultUserId: options.defaultReflexUserId ?? "local-user",
      }),
    );
  }

  // ─── Mode-based tool filtering ───
  const mode = options?.operationalMode;
  if (mode && mode !== "execute") {
    return filterToolsByMode(tools, mode);
  }

  return tools;
}

// ─── Deferred tool loading ───

/**
 * Tools that are always included in the initial LLM prompt.
 * All others are considered deferred and only described by name.
 */
const ALWAYS_LOAD_TOOLS = new Set([
  "exec",
  "read",
  "write",
  "edit",
  "web_fetch",
  "web_search",
  "skill_run",
  "skill_generate",
  "skills_list",
  "workflow_list",
  "workflow_generate",
  "memory_search",
  "memory_store",
  "autonomous",
  "controlled_autonomy",
  "capabilities",
  "task_status",
  "reflex_candidate_list",
  "reflex_candidate_decide",
  "reflex_preference_update",
]);

export interface FridayAgentToolRegistryPartitioned {
  /** Tools whose full schema is sent in the initial prompt. */
  alwaysLoad: FridayAgentToolDefinition[];
  /** Tools available on demand — only names/descriptions sent initially. */
  deferred: FridayAgentToolDefinition[];
}

/**
 * Partition a tool array into always-load and deferred groups.
 * Deferred tools are not sent to the LLM initially, saving tokens.
 */
export function partitionFridayAgentTools(
  tools: FridayAgentToolDefinition[],
): FridayAgentToolRegistryPartitioned {
  const alwaysLoad: FridayAgentToolDefinition[] = [];
  const deferred: FridayAgentToolDefinition[] = [];

  for (const tool of tools) {
    if (ALWAYS_LOAD_TOOLS.has(tool.name)) {
      alwaysLoad.push(tool);
    } else {
      deferred.push(tool);
    }
  }

  return { alwaysLoad, deferred };
}
