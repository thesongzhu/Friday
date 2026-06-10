import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import {
  buildFridayRuntimeCapabilityMatrix,
  FRIDAY_RUNTIME_CAPABILITY_IDS,
  type FridayRuntimeCapabilityId,
  type FridayRuntimeCapabilityItem,
  type FridayRuntimeCapabilityMatrix,
} from "#providers";
import type { FridayAgentCapabilitiesSnapshot } from "../../agent/tools/friday-agent-capabilities-tool.js";
import type {
  FridayAutonomyPolicy,
  FridayCapabilityAcquisitionRun,
  FridayCapabilityAcquisitionStep,
  FridayCapabilityAvailabilityBoundary,
  FridayCapabilityCandidate,
  FridayCapabilityExecutionSuggestion,
  FridayCapabilityVerificationResult,
  FridayPlanCapabilityAcquisitionInput,
  FridayRegisteredCapabilityResult,
  FridayStartCapabilityAcquisitionInput,
} from "../model/friday-controlled-autonomy.types.js";
import type { FridayAutonomyPolicyService } from "./friday-autonomy-policy-service.js";
import {
  evaluateFridayAutonomyRisks,
  mapFridayRuntimeRisksToAutonomyRisks,
  normalizeFridayAutonomyRisks,
} from "./friday-autonomy-policy-service.js";

export interface CreateFridayCapabilityAcquisitionServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  policyService: FridayAutonomyPolicyService;
  capabilitySnapshotGetter?: (input: { readOnly: boolean }) =>
    Promise<FridayAgentCapabilitiesSnapshot> | FridayAgentCapabilitiesSnapshot;
  /**
   * Test-oracle only: allows legacy TypeScript capability-acquisition run
   * mutations (`startRun`/`approveRun`/`cancelRun`) in isolated test/validation
   * harnesses. Default/live runtime must leave this unset so the methods fail
   * closed for ALL callers — including the agent controlled-autonomy tool and
   * the standing-agenda service, which bypass the HTTP route guard.
   */
  allowTestOnlyCapabilityAcquisitionExecution?: boolean;
}

export interface FridayCapabilityAcquisitionService {
  plan(input: FridayPlanCapabilityAcquisitionInput): Promise<FridayCapabilityAcquisitionRun>;
  startRun(input: FridayStartCapabilityAcquisitionInput): Promise<FridayCapabilityAcquisitionRun>;
  getRun(runId: string): FridayCapabilityAcquisitionRun | null;
  approveRun(runId: string): Promise<FridayCapabilityAcquisitionRun>;
  cancelRun(runId: string): FridayCapabilityAcquisitionRun;
}

interface AcquisitionRunRow {
  id: string;
  user_id: string;
  goal: string;
  status: string;
  required_capabilities_json: string;
  missing_capabilities_json: string;
  matrix_summary_json: string;
  policy_snapshot_json: string;
  candidates_json: string;
  plan_json: string;
  human_blockers_json: string;
  approval_reasons_json: string;
  verification_results_json: string;
  registered_capabilities_json: string;
  execution_suggestion_json: string;
  created_at: string;
  updated_at: string;
}

const CAPABILITY_SET = new Set<string>(FRIDAY_RUNTIME_CAPABILITY_IDS);
const LOCAL_CANDIDATE_SOURCE_TYPES = new Set<FridayCapabilityCandidate["sourceType"]>([
  "skill_generator",
  "workflow_generator",
  "studio_artifact",
  "builtin_catalog",
]);

export function createFridayCapabilityAcquisitionService(
  deps: CreateFridayCapabilityAcquisitionServiceDeps,
): FridayCapabilityAcquisitionService {
  const { db, idGenerator, nowIso, policyService } = deps;

  // ─── TS Runtime Retirement: METHOD-level fail-closed guard ───
  // Phase 3 (route-only-guard defect): the capability-acquisition retirement
  // was ROUTE-only (friday-autonomy-routes asserts the test-oracle flag before
  // the acquisition routes). The agent controlled-autonomy tool
  // (`acquisition_start`/`acquisition_approve`/`acquisition_cancel`) and the
  // standing-agenda service (`runAgendaItem` → `acquisitionService.startRun`)
  // reach these methods directly, bypassing the HTTP route guard. Guarding here
  // fails ALL non-route callers closed BEFORE any run-row write, capability
  // probe, or verification side effect — unless the explicit test-oracle flag
  // is set. Never default this flag on in production. Reads (`plan`/`getRun`)
  // stay live; only run mutations are retired, mirroring the route surface.
  function assertCapabilityAcquisitionExecutionAllowed(): void {
    if (deps.allowTestOnlyCapabilityAcquisitionExecution !== true) {
      throw new FridayDomainError(
        "TS_RUNTIME_CAPABILITY_ACQUISITION_RETIRED",
        "TypeScript capability-acquisition execution is fail-closed in default/live runtime; use the Rust-owned capability_acquisition entrypoint.",
        {
          httpStatus: 503,
          details: {
            classification: "fail_closed",
            replacement: "rust_owned_capability_acquisition_entrypoint_required",
          },
        },
      );
    }
  }

  async function resolveMatrix(readOnly: boolean): Promise<FridayRuntimeCapabilityMatrix> {
    if (!deps.capabilitySnapshotGetter) {
      return buildFridayRuntimeCapabilityMatrix({
        nowIso: nowIso(),
        readOnly,
        providers: [],
        pdfParseEnabled: false,
        browserEnabled: false,
        skillCount: 0,
      });
    }
    const snapshot = await Promise.resolve(deps.capabilitySnapshotGetter({ readOnly }));
    return snapshot.runtime ?? buildFridayRuntimeCapabilityMatrix({
      nowIso: nowIso(),
      readOnly,
      providers: [],
      pdfParseEnabled: false,
      browserEnabled: false,
      skillCount: 0,
    });
  }

  async function plan(input: FridayPlanCapabilityAcquisitionInput): Promise<FridayCapabilityAcquisitionRun> {
    const policy = policyService.getPolicy();
    const matrix = await resolveMatrix(input.readOnly ?? false);
    return buildRun({
      id: `plan-${idGenerator()}`,
      userId: input.userId,
      goal: input.goal,
      requiredCapabilities: normalizeRequiredCapabilities(
        input.requiredCapabilities ?? inferRequiredCapabilities(input.goal),
      ),
      matrix,
      policy,
      now: nowIso(),
    });
  }

  async function startRun(input: FridayStartCapabilityAcquisitionInput): Promise<FridayCapabilityAcquisitionRun> {
    assertCapabilityAcquisitionExecutionAllowed();
    const policy = policyService.getPolicy();
    const matrix = await resolveMatrix(input.readOnly ?? false);
    const run = buildRun({
      id: idGenerator(),
      userId: input.userId,
      goal: input.goal,
      requiredCapabilities: normalizeRequiredCapabilities(
        input.requiredCapabilities ?? inferRequiredCapabilities(input.goal),
      ),
      matrix,
      policy,
      now: nowIso(),
      externalCandidates: input.studioArtifactCandidates,
    });
    saveRun(run);
    return run;
  }

  function getRun(runId: string): FridayCapabilityAcquisitionRun | null {
    const row = db.withReadConnection((conn) =>
      conn.prepare("SELECT * FROM friday_capability_acquisition_runs WHERE id = ?").get(runId) as AcquisitionRunRow | undefined,
    );
    return row ? rowToRun(row) : null;
  }

  async function approveRun(runId: string): Promise<FridayCapabilityAcquisitionRun> {
    assertCapabilityAcquisitionExecutionAllowed();
    const current = getRun(runId);
    if (!current) {
      throw new FridayDomainError("CAPABILITY_ACQUISITION_RUN_NOT_FOUND", "Capability acquisition run not found", {
        httpStatus: 404,
      });
    }
    if (current.status === "cancelled") {
      return current;
    }

    const liveMatrix = await resolveMatrix(false);
    const liveItemByCapability = new Map(liveMatrix.items.map((item) => [item.capability, item]));

    if (current.humanBlockers.length > 0) {
      const unresolvedBlockers = collectHumanBlockers(
        current.candidates,
        current.requiredCapabilities.filter((cap) => liveItemByCapability.get(cap)?.state !== "available"),
      );
      if (unresolvedBlockers.length > 0) {
        const blocked = {
          ...current,
          status: "human_blocked" as const,
          humanBlockers: unresolvedBlockers,
          updatedAt: nowIso(),
        };
        saveRun(blocked);
        return blocked;
      }
    }

    const verifiedAt = nowIso();
    const verificationResults: FridayCapabilityVerificationResult[] = [];
    const registeredCapabilities: FridayRegisteredCapabilityResult[] = [];
    const byCapability = new Map<FridayRuntimeCapabilityId, FridayCapabilityCandidate>();
    for (const candidate of current.candidates) {
      if (!byCapability.has(candidate.capability)) {
        byCapability.set(candidate.capability, candidate);
      }
    }

    for (const capability of current.requiredCapabilities) {
      const candidate = byCapability.get(capability);
      if (!candidate) {
        verificationResults.push({
          candidateId: "none",
          capability,
          status: "failed",
          evidence: `No candidate found for ${capability}.`,
          verifiedAt,
        });
        continue;
      }
      const liveItem = liveItemByCapability.get(capability);
      const passed = candidate.sourceType === "available_runtime"
        || candidate.sourceType === "skill_generator"
        || candidate.sourceType === "workflow_generator"
        || candidate.sourceType === "studio_artifact"
        || candidate.sourceType === "builtin_catalog"
        || liveItem?.state === "available";
      const liveVerified = passed
        && candidate.sourceType !== "available_runtime"
        && !LOCAL_CANDIDATE_SOURCE_TYPES.has(candidate.sourceType);
      const availabilityBoundary = buildAvailabilityBoundary({
        candidate,
        passed,
        liveVerified,
      });
      const localCandidateOnly = availabilityBoundary.proofTier === "local_candidate_registered";
      verificationResults.push({
        candidateId: candidate.id,
        capability,
        status: passed && !localCandidateOnly ? "passed" : "blocked",
        evidence: passed
          ? liveVerified
            ? `Live runtime capability matrix confirms ${capability} is available after external setup; doctor state verified at runtime.`
            : candidate.sourceType === "available_runtime"
              ? `Runtime capability matrix already reports ${capability} as available.`
              : localCandidateOnly
                ? `Sandbox/doctor dry-run accepted ${candidate.label}, but lifecycle promotion or installation proof is missing; execution remains blocked.`
                : `Sandbox/doctor verification accepted ${candidate.label}; inspect availability proof before execution.`
          : `${candidate.label} still requires external setup or installation evidence before registration.`,
        verifiedAt,
        availabilityBoundary,
        ...(passed && !localCandidateOnly
          ? {}
          : {
              blocker: localCandidateOnly
                ? "Lifecycle promotion or installation proof is required before this candidate can execute."
                : "External setup/install must complete and pass doctor verification.",
            }),
      });
      if (passed) {
        registeredCapabilities.push({
          capability,
          sourceCandidateId: candidate.id,
          registeredAt: verifiedAt,
          state: localCandidateOnly ? "blocked" : "available",
          note: liveVerified
            ? "External setup completed; live capability matrix confirms availability via runtime doctor."
            : candidate.sourceType === "available_runtime"
              ? "Already present in runtime capability matrix."
              : "Generated/local candidate passed the sandbox gate, but remains blocked from task execution until lifecycle promotion or installation proof exists.",
          availabilityBoundary,
        });
      }
    }

    const allRegistered = current.requiredCapabilities.every((capability) =>
      registeredCapabilities.some((registered) => registered.capability === capability && registered.state === "available"),
    );
    const next: FridayCapabilityAcquisitionRun = {
      ...current,
      status: allRegistered ? "verified" : "human_blocked",
      verificationResults,
      registeredCapabilities,
      executionSuggestion: allRegistered
        ? {
            canExecute: true,
            reason: summarizeRegisteredAvailability(registeredCapabilities),
            requiredCapabilities: current.requiredCapabilities,
            nextAction: "execute_task",
            availabilityBoundary: summarizeAvailabilityBoundary(registeredCapabilities),
          }
        : {
            canExecute: false,
            reason: summarizeBlockedRegistration(registeredCapabilities),
            requiredCapabilities: current.requiredCapabilities,
            nextAction: "complete_human_setup",
            availabilityBoundary: summarizeAvailabilityBoundary(registeredCapabilities),
          },
      updatedAt: verifiedAt,
    };
    saveRun(next);
    return next;
  }

  function cancelRun(runId: string): FridayCapabilityAcquisitionRun {
    assertCapabilityAcquisitionExecutionAllowed();
    const current = getRun(runId);
    if (!current) {
      throw new FridayDomainError("CAPABILITY_ACQUISITION_RUN_NOT_FOUND", "Capability acquisition run not found", {
        httpStatus: 404,
      });
    }
    const cancelled = {
      ...current,
      status: "cancelled" as const,
      executionSuggestion: {
        canExecute: false,
        reason: "Capability acquisition was cancelled.",
        requiredCapabilities: current.requiredCapabilities,
        nextAction: "cancel_or_replan" as const,
      },
      updatedAt: nowIso(),
    };
    saveRun(cancelled);
    return cancelled;
  }

  function saveRun(run: FridayCapabilityAcquisitionRun): void {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO friday_capability_acquisition_runs (
          id,
          user_id,
          goal,
          status,
          required_capabilities_json,
          missing_capabilities_json,
          matrix_summary_json,
          policy_snapshot_json,
          candidates_json,
          plan_json,
          human_blockers_json,
          approval_reasons_json,
          verification_results_json,
          registered_capabilities_json,
          execution_suggestion_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          required_capabilities_json = excluded.required_capabilities_json,
          missing_capabilities_json = excluded.missing_capabilities_json,
          matrix_summary_json = excluded.matrix_summary_json,
          policy_snapshot_json = excluded.policy_snapshot_json,
          candidates_json = excluded.candidates_json,
          plan_json = excluded.plan_json,
          human_blockers_json = excluded.human_blockers_json,
          approval_reasons_json = excluded.approval_reasons_json,
          verification_results_json = excluded.verification_results_json,
          registered_capabilities_json = excluded.registered_capabilities_json,
          execution_suggestion_json = excluded.execution_suggestion_json,
          updated_at = excluded.updated_at`,
      ).run(
        run.id,
        run.userId,
        run.goal,
        run.status,
        JSON.stringify(run.requiredCapabilities),
        JSON.stringify(run.missingCapabilities),
        JSON.stringify(run.matrixSummary),
        JSON.stringify(run.policySnapshot),
        JSON.stringify(run.candidates),
        JSON.stringify(run.plan),
        JSON.stringify(run.humanBlockers),
        JSON.stringify(run.approvalReasons),
        JSON.stringify(run.verificationResults),
        JSON.stringify(run.registeredCapabilities),
        JSON.stringify(run.executionSuggestion),
        run.createdAt,
        run.updatedAt,
      );
    });
  }

  return {
    plan,
    startRun,
    getRun,
    approveRun,
    cancelRun,
  };
}

function buildRun(input: {
  id: string;
  userId: string;
  goal: string;
  requiredCapabilities: FridayRuntimeCapabilityId[];
  matrix: FridayRuntimeCapabilityMatrix;
  policy: FridayAutonomyPolicy;
  now: string;
  externalCandidates?: FridayCapabilityCandidate[];
}): FridayCapabilityAcquisitionRun {
  const now = input.now;
  const itemByCapability = new Map(input.matrix.items.map((item) => [item.capability, item]));
  const missingCapabilities = input.requiredCapabilities.filter((capability) =>
    itemByCapability.get(capability)?.state !== "available",
  );
  const builtCandidates = input.requiredCapabilities.flatMap((capability) =>
    buildCandidatesForCapability({
      capability,
      item: itemByCapability.get(capability),
      policy: input.policy,
      goal: input.goal,
    }),
  );
  const merged = input.externalCandidates
    ? [...builtCandidates, ...input.externalCandidates]
    : builtCandidates;
  const candidates = rankCandidates(merged);
  const humanBlockers = collectHumanBlockers(candidates, input.requiredCapabilities);
  const approvalReasons = collectApprovalReasons(candidates, input.requiredCapabilities);
  const plan = buildAcquisitionPlan(input.requiredCapabilities, missingCapabilities, candidates);
  const status = resolveInitialStatus(missingCapabilities, humanBlockers, approvalReasons);
  return {
    id: input.id,
    userId: input.userId,
    goal: input.goal,
    status,
    requiredCapabilities: input.requiredCapabilities,
    missingCapabilities,
    matrixSummary: input.matrix.summary,
    policySnapshot: input.policy,
    candidates,
    plan,
    humanBlockers,
    approvalReasons,
    verificationResults: [],
    registeredCapabilities: [],
    executionSuggestion: buildExecutionSuggestion(status, input.requiredCapabilities, missingCapabilities, humanBlockers, approvalReasons),
    createdAt: now,
    updatedAt: now,
  };
}

function buildCandidatesForCapability(input: {
  capability: FridayRuntimeCapabilityId;
  item?: FridayRuntimeCapabilityItem;
  policy: FridayAutonomyPolicy;
  goal: string;
}): FridayCapabilityCandidate[] {
  const { capability, item, policy } = input;
  const candidates: FridayCapabilityCandidate[] = [];
  if (item?.state === "available") {
    const source = item.sources.find((candidate) => candidate.status === "verified") ?? item.sources[0];
    candidates.push({
      id: `${capability}:runtime`,
      capability,
      sourceType: "available_runtime",
      trustTier: "installed",
      label: source?.label ?? item.label,
      description: item.description,
      risks: [],
      requiresApproval: false,
      requiresHuman: false,
      rank: 0,
    });
    return candidates;
  }

  for (const repair of item?.repairOptions ?? []) {
    const risks = mapFridayRuntimeRisksToAutonomyRisks(repair.risks);
    const decision = evaluateFridayAutonomyRisks(policy, risks);
    candidates.push({
      id: `${capability}:repair:${repair.id}`,
      capability,
      sourceType: repair.kind === "configure_provider" ? "setup_recipe" : "repair_option",
      trustTier: repair.kind === "configure_provider" ? "official" : "trusted_local",
      label: repair.label,
      description: repair.description,
      risks,
      requiresApproval: repair.requiresApproval || decision.approvalRequired,
      requiresHuman: decision.hardHumanBlockers.length > 0,
      rank: repair.kind === "configure_provider" ? 20 : 40,
      setupHref: repair.setupHref,
      href: repair.href,
      repairOptionId: repair.id,
      repairOption: repair,
    });
  }

  if (capability === "custom" || capability === "skills") {
    candidates.push(generatedCandidate(capability, "skill_generator", "Generate a Friday skill", "Generate a scoped Friday skill, run safety validation, then sandbox-test before registration.", policy, 45));
  }
  if (capability === "custom") {
    candidates.push(generatedCandidate(capability, "workflow_generator", "Generate a workflow", "Generate a workflow with explicit inputs, approvals, evidence, and rollback metadata.", policy, 50));
    candidates.push(openInternetCandidate(capability, "openapi", "Discover OpenAPI integration", "Search official OpenAPI documentation and build a generated skill from the schema.", policy, 70));
    candidates.push(openInternetCandidate(capability, "github", "Search GitHub capability candidates", "Search GitHub for maintained tools or MCP servers, then sandbox before install.", policy, 80));
    candidates.push(openInternetCandidate(capability, "npm", "Search npm capability candidates", "Search npm for maintained packages, then sandbox before install.", policy, 85));
  }
  if (capability === "mcp") {
    candidates.push(openInternetCandidate(capability, "mcp_registry", "Discover MCP server", "Search trusted MCP registries and require permission review before installation.", policy, 65));
  }
  if (capability === "ocr" || capability === "web_search" || capability === "pdf_parse") {
    candidates.push(openInternetCandidate(capability, "web_search", `Search for ${capability} providers`, "Find official provider documentation and setup recipes; credentials stay human-gated.", policy, 75));
  }

  return candidates;
}

function generatedCandidate(
  capability: FridayRuntimeCapabilityId,
  sourceType: "skill_generator" | "workflow_generator",
  label: string,
  description: string,
  policy: FridayAutonomyPolicy,
  rank: number,
): FridayCapabilityCandidate {
  const risks = normalizeFridayAutonomyRisks(["local_file_write"]);
  const decision = evaluateFridayAutonomyRisks(policy, risks);
  return {
    id: `${capability}:${sourceType}`,
    capability,
    sourceType,
    trustTier: "generated",
    label,
    description,
    risks,
    requiresApproval: true,
    requiresHuman: decision.hardHumanBlockers.length > 0,
    rank,
  };
}

function openInternetCandidate(
  capability: FridayRuntimeCapabilityId,
  sourceType: "mcp_registry" | "github" | "npm" | "openapi" | "web_search",
  label: string,
  description: string,
  policy: FridayAutonomyPolicy,
  rank: number,
): FridayCapabilityCandidate {
  const risks = normalizeFridayAutonomyRisks(
    sourceType === "web_search" || sourceType === "openapi"
      ? ["network_call"]
      : sourceType === "mcp_registry"
        ? ["network_call", "external_download", "mcp_install"]
        : ["network_call", "external_download", "npm_github_install"],
  );
  const decision = evaluateFridayAutonomyRisks(policy, risks);
  return {
    id: `${capability}:${sourceType}`,
    capability,
    sourceType,
    trustTier: "open_internet",
    label,
    description,
    risks,
    requiresApproval: decision.approvalRequired || risks.length > 0,
    requiresHuman: decision.hardHumanBlockers.length > 0,
    rank,
  };
}

function rankCandidates(candidates: FridayCapabilityCandidate[]): FridayCapabilityCandidate[] {
  return [...candidates]
    .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function inferRequiredCapabilities(goal: string): FridayRuntimeCapabilityId[] {
  const text = goal.toLowerCase();
  const required = new Set<FridayRuntimeCapabilityId>(["text"]);
  if (matches(text, ["image", "photo", "picture", "vision", "看图", "图片", "照片", "图像", "识图"])) {
    required.add("vision");
  }
  if (matches(text, ["ocr", "scan", "scanned", "文字识别", "识别文字", "图片文字", "截图文字", "扫描件"])) {
    required.add("ocr");
  }
  if (matches(text, ["embed", "embedding", "semantic", "memory search", "向量", "语义", "记忆搜索"])) {
    required.add("embedding");
  }
  if (matches(text, ["web", "search", "latest", "news", "internet", "联网", "搜索", "全网", "最新", "新闻", "查一下"])) {
    required.add("web_search");
  }
  if (matches(text, ["url", "网页", "链接", "抓取", "fetch"])) {
    required.add("web_fetch");
  }
  if (matches(text, ["pdf", "论文", "文档解析", "pdf解析"])) {
    required.add("pdf_parse");
  }
  if (matches(text, ["file", "read file", "读取文件", "本地文件"])) {
    required.add("file_read");
  }
  if (matches(text, ["write", "edit", "modify", "生成文件", "写文件", "修改文件", "保存"])) {
    required.add("file_write");
  }
  if (matches(text, ["tts", "speech", "voice", "语音", "朗读", "配音", "文字转语音"])) {
    required.add("tts");
  }
  if (matches(text, ["browser", "click", "login", "网页操作", "浏览器", "打开网页", "点击"])) {
    required.add("browser");
  }
  if (matches(text, ["mcp", "model context protocol"])) {
    required.add("mcp");
  }
  if (matches(text, ["skill", "tool", "workflow", "api integration", "插件", "技能", "工具", "工作流", "接口", "集成"])) {
    required.add("skills");
    required.add("custom");
  }
  return [...required].filter((capability) => CAPABILITY_SET.has(capability));
}

function normalizeRequiredCapabilities(
  capabilities: readonly FridayRuntimeCapabilityId[],
): FridayRuntimeCapabilityId[] {
  const normalized = new Set<FridayRuntimeCapabilityId>(["text"]);
  for (const capability of capabilities) {
    if (CAPABILITY_SET.has(capability)) {
      normalized.add(capability);
    }
  }
  return [...normalized];
}

function matches(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle.toLowerCase()));
}

function buildAvailabilityBoundary(input: {
  candidate: FridayCapabilityCandidate;
  passed: boolean;
  liveVerified: boolean;
}): FridayCapabilityAvailabilityBoundary {
  if (!input.passed) {
    return {
      proofTier: "blocked_or_unverified",
      liveRuntimeVerified: false,
      localCandidateOnly: false,
      summary: "This capability is not registered because setup, install evidence, or doctor verification is still missing.",
    };
  }
  if (input.candidate.sourceType === "available_runtime") {
    return {
      proofTier: "already_available_runtime",
      liveRuntimeVerified: true,
      localCandidateOnly: false,
      summary: "This capability was already present in the current runtime matrix.",
    };
  }
  if (input.liveVerified) {
    return {
      proofTier: "live_runtime_verified",
      liveRuntimeVerified: true,
      localCandidateOnly: false,
      summary: "External setup completed and the live runtime capability matrix confirmed availability.",
    };
  }
  if (LOCAL_CANDIDATE_SOURCE_TYPES.has(input.candidate.sourceType)) {
    return {
      proofTier: "local_candidate_registered",
      liveRuntimeVerified: false,
      localCandidateOnly: true,
      summary: "Generated/local candidate proof only: sandbox or doctor dry-run accepted this candidate, but this is not proof of external install, live provider availability, or lifecycle promotion.",
    };
  }
  return {
    proofTier: "blocked_or_unverified",
    liveRuntimeVerified: false,
    localCandidateOnly: false,
    summary: "This capability still needs external setup or installation evidence before live availability can be claimed.",
  };
}

function summarizeAvailabilityBoundary(
  registeredCapabilities: readonly FridayRegisteredCapabilityResult[],
): FridayCapabilityAvailabilityBoundary | undefined {
  const boundaries = registeredCapabilities
    .map((item) => item.availabilityBoundary)
    .filter((value): value is FridayCapabilityAvailabilityBoundary => value !== undefined);
  if (boundaries.length === 0) return undefined;
  if (boundaries.some((boundary) => boundary.proofTier === "local_candidate_registered")) {
    return {
      proofTier: "local_candidate_registered",
      liveRuntimeVerified: false,
      localCandidateOnly: true,
      summary: "One or more required capabilities are available only through generated/local candidate registration; do not treat this as installed external/live capability proof.",
    };
  }
  if (boundaries.some((boundary) => boundary.proofTier === "live_runtime_verified")) {
    return {
      proofTier: "live_runtime_verified",
      liveRuntimeVerified: true,
      localCandidateOnly: false,
      summary: "Required capabilities are backed by live runtime verification or already-present runtime capabilities.",
    };
  }
  return boundaries[0];
}

function summarizeRegisteredAvailability(
  registeredCapabilities: readonly FridayRegisteredCapabilityResult[],
): string {
  const boundary = summarizeAvailabilityBoundary(registeredCapabilities);
  if (boundary?.proofTier === "local_candidate_registered") {
    return "All required capabilities are registered, but at least one is only a generated/local candidate with sandbox or dry-run proof; do not treat it as installed, promoted, or live-provider verified.";
  }
  if (boundary?.proofTier === "live_runtime_verified") {
    return "All required capabilities are verified against the live runtime matrix or already present.";
  }
  return "All required capabilities are verified or registered.";
}

function summarizeBlockedRegistration(
  registeredCapabilities: readonly FridayRegisteredCapabilityResult[],
): string {
  const boundary = summarizeAvailabilityBoundary(registeredCapabilities);
  if (boundary?.proofTier === "local_candidate_registered") {
    return "At least one generated/local candidate passed sandbox or dry-run proof, but it is not installed, promoted, or live-provider verified; complete the lifecycle before task execution.";
  }
  return "At least one candidate still needs external setup, installation evidence, or a provider key.";
}

function collectHumanBlockers(
  candidates: readonly FridayCapabilityCandidate[],
  requiredCapabilities: readonly FridayRuntimeCapabilityId[],
): string[] {
  const blockers: string[] = [];
  for (const capability of requiredCapabilities) {
    const best = candidates.find((candidate) => candidate.capability === capability);
    if (!best) {
      blockers.push(`No acquisition candidate found for ${capability}.`);
      continue;
    }
    if (best.requiresHuman) {
      const reason = best.risks.includes("api_key")
        ? "API key or provider credential is required."
        : best.risks.includes("oauth")
          ? "OAuth authorization is required."
          : best.risks.includes("login")
            ? "External account login is required."
            : "Human setup is required.";
      blockers.push(`${capability}: ${best.label} requires human setup (${best.risks.join(", ")}). ${reason}`);
    }
  }
  return blockers;
}

function collectApprovalReasons(
  candidates: readonly FridayCapabilityCandidate[],
  requiredCapabilities: readonly FridayRuntimeCapabilityId[],
): string[] {
  const reasons: string[] = [];
  for (const capability of requiredCapabilities) {
    const best = candidates.find((candidate) => candidate.capability === capability);
    if (best?.requiresApproval) {
      reasons.push(`${capability}: ${best.label} requires approval before install/register/use.`);
    }
  }
  return reasons;
}

function buildAcquisitionPlan(
  requiredCapabilities: readonly FridayRuntimeCapabilityId[],
  missingCapabilities: readonly FridayRuntimeCapabilityId[],
  candidates: readonly FridayCapabilityCandidate[],
): FridayCapabilityAcquisitionStep[] {
  const steps: FridayCapabilityAcquisitionStep[] = [];
  for (const capability of requiredCapabilities) {
    const candidate = candidates.find((item) => item.capability === capability);
    if (!candidate) {
      steps.push({
        id: `${capability}:blocked`,
        title: `No route for ${capability}`,
        action: "discover",
        capability,
        status: "blocked",
        requiresApproval: false,
        requiresHuman: true,
        detail: "No available, setup, generated, local, or internet candidate was found.",
      });
      continue;
    }
    if (!missingCapabilities.includes(capability)) {
      steps.push({
        id: `${capability}:use_available`,
        title: `Use verified ${capability}`,
        action: "use_available",
        capability,
        candidateId: candidate.id,
        status: "done",
        requiresApproval: false,
        requiresHuman: false,
        detail: candidate.description,
      });
      continue;
    }
    steps.push({
      id: `${capability}:discover`,
      title: `Select candidate for ${capability}`,
      action: candidate.sourceType === "skill_generator" || candidate.sourceType === "workflow_generator" ? "generate" : "discover",
      capability,
      candidateId: candidate.id,
      status: candidate.requiresHuman ? "blocked" : "ready",
      requiresApproval: candidate.requiresApproval,
      requiresHuman: candidate.requiresHuman,
      detail: candidate.description,
    });
    steps.push({
      id: `${capability}:verify`,
      title: `Sandbox and doctor verify ${capability}`,
      action: "sandbox_verify",
      capability,
      candidateId: candidate.id,
      status: "pending",
      requiresApproval: candidate.requiresApproval,
      requiresHuman: candidate.requiresHuman,
      detail: "Candidate cannot become routable until sandbox tests and doctor verification pass.",
    });
    steps.push({
      id: `${capability}:register`,
      title: `Register ${capability}`,
      action: "install_register",
      capability,
      candidateId: candidate.id,
      status: "pending",
      requiresApproval: candidate.requiresApproval,
      requiresHuman: candidate.requiresHuman,
      detail: "Only verified candidates are written into runtime capability routing.",
    });
  }
  steps.push({
    id: "execute",
    title: "Execute original goal",
    action: "execute",
    status: missingCapabilities.length === 0 ? "ready" : "pending",
    requiresApproval: false,
    requiresHuman: false,
    detail: "Run the user task once all required capabilities are available.",
  });
  return steps;
}

function resolveInitialStatus(
  missingCapabilities: readonly FridayRuntimeCapabilityId[],
  humanBlockers: readonly string[],
  approvalReasons: readonly string[],
): FridayCapabilityAcquisitionRun["status"] {
  if (missingCapabilities.length === 0) {
    return "verified";
  }
  if (humanBlockers.length > 0) {
    return "human_blocked";
  }
  if (approvalReasons.length > 0) {
    return "awaiting_approval";
  }
  return "planned";
}

function buildExecutionSuggestion(
  status: FridayCapabilityAcquisitionRun["status"],
  requiredCapabilities: FridayRuntimeCapabilityId[],
  missingCapabilities: FridayRuntimeCapabilityId[],
  humanBlockers: readonly string[],
  approvalReasons: readonly string[],
): FridayCapabilityExecutionSuggestion {
  if (status === "verified") {
    return {
      canExecute: true,
      reason: missingCapabilities.length === 0
        ? "All required capabilities are already available."
        : "All required capabilities are verified and registered.",
      requiredCapabilities,
      nextAction: "execute_task",
      availabilityBoundary: {
        proofTier: "already_available_runtime",
        liveRuntimeVerified: true,
        localCandidateOnly: false,
        summary: "The required capabilities were already present in the current runtime matrix.",
      },
    };
  }
  if (humanBlockers.length > 0) {
    return {
      canExecute: false,
      reason: humanBlockers.join(" "),
      requiredCapabilities,
      nextAction: "complete_human_setup",
    };
  }
  if (approvalReasons.length > 0) {
    return {
      canExecute: false,
      reason: approvalReasons.join(" "),
      requiredCapabilities,
      nextAction: "approve_run",
    };
  }
  return {
    canExecute: false,
    reason: "Capability acquisition plan is ready but has not been executed.",
    requiredCapabilities,
    nextAction: "approve_run",
  };
}

function rowToRun(row: AcquisitionRunRow): FridayCapabilityAcquisitionRun {
  return {
    id: row.id,
    userId: row.user_id,
    goal: row.goal,
    status: row.status as FridayCapabilityAcquisitionRun["status"],
    requiredCapabilities: readJson(row.required_capabilities_json, []),
    missingCapabilities: readJson(row.missing_capabilities_json, []),
    matrixSummary: readJson(row.matrix_summary_json, { available: 0, needsVerification: 0, needsUserAction: 0, installable: 0, unsupported: 0 }),
    policySnapshot: readJson(row.policy_snapshot_json, {} as FridayAutonomyPolicy),
    candidates: readJson(row.candidates_json, []),
    plan: readJson(row.plan_json, []),
    humanBlockers: readJson(row.human_blockers_json, []),
    approvalReasons: readJson(row.approval_reasons_json, []),
    verificationResults: readJson(row.verification_results_json, []),
    registeredCapabilities: readJson(row.registered_capabilities_json, []),
    executionSuggestion: readJson(row.execution_suggestion_json, {
      canExecute: false,
      reason: "No execution suggestion was recorded.",
      requiredCapabilities: [],
      nextAction: "cancel_or_replan",
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
