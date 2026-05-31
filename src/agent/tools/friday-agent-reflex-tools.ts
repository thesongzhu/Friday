import type {
  FridayReflexCandidate,
  FridayReflexCandidateKind,
  FridayReflexCandidateStatus,
  FridayReflexService,
  FridayReflexSurface,
} from "../../reflex/index.js";
import { requiresFridayReflexPreferenceConfirmation } from "../../reflex/index.js";
import type { FridayUserPreferenceCategory, JsonValue } from "../../uix/model/friday-uix.types.js";
import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import { jsonResult, readNumberParam, readStringParam } from "./friday-agent-tool-helpers.js";

const CANDIDATE_STATUSES = new Set<FridayReflexCandidateStatus>([
  "proposed",
  "testing",
  "ready_for_review",
  "approved",
  "rejected",
  "dismissed",
  "failed",
  "superseded",
]);

const CANDIDATE_KINDS = new Set<FridayReflexCandidateKind>([
  "memory",
  "learned_fact",
  "preference",
  "recipe",
  "skill",
  "workflow",
  "fix",
  "test_policy",
]);

const PREFERENCE_CATEGORIES = new Set<FridayUserPreferenceCategory>([
  "communication",
  "uix",
  "reflex",
]);

const SURFACES = new Set<FridayReflexSurface>(["channel", "operate"]);
const HIGH_IMPACT_MEMORY_TERMS = [
  "approval",
  "automation",
  "execute",
  "execution",
  "mcp",
  "permission",
  "provider",
  "release",
  "remote",
  "safety",
  "secret",
  "skill",
  "socket",
  "system",
  "test",
  "token",
  "workflow",
  "安全",
  "执行",
  "权限",
  "自动",
  "密钥",
] as const;

export interface CreateFridayAgentReflexToolsOptions {
  reflexService?: FridayReflexService;
  reflexServiceGetter?: () => FridayReflexService | undefined;
  defaultUserId: string;
}

function resolveUserId(args: Record<string, unknown>, defaultUserId: string): string {
  return typeof args["__principalId"] === "string" && args["__principalId"].trim().length > 0
    ? args["__principalId"].trim()
    : defaultUserId;
}

function readCandidateStatus(args: Record<string, unknown>): FridayReflexCandidateStatus | undefined {
  const status = readStringParam(args, "status");
  if (!status) return undefined;
  if (!CANDIDATE_STATUSES.has(status as FridayReflexCandidateStatus)) {
    throw new Error(`Invalid reflex candidate status: ${status}`);
  }
  return status as FridayReflexCandidateStatus;
}

function readCandidateKind(args: Record<string, unknown>): FridayReflexCandidateKind | undefined {
  const kind = readStringParam(args, "kind");
  if (!kind) return undefined;
  if (!CANDIDATE_KINDS.has(kind as FridayReflexCandidateKind)) {
    throw new Error(`Invalid reflex candidate kind: ${kind}`);
  }
  return kind as FridayReflexCandidateKind;
}

function readPreferenceCategory(args: Record<string, unknown>): FridayUserPreferenceCategory {
  const category = readStringParam(args, "category", { required: true });
  if (!PREFERENCE_CATEGORIES.has(category as FridayUserPreferenceCategory)) {
    throw new Error("category must be communication, uix, or reflex");
  }
  return category as FridayUserPreferenceCategory;
}

function readSurface(args: Record<string, unknown>): FridayReflexSurface {
  const surface = readStringParam(args, "sourceSurface");
  if (!surface) return "operate";
  if (!SURFACES.has(surface as FridayReflexSurface)) {
    throw new Error("sourceSurface must be channel or operate");
  }
  return surface as FridayReflexSurface;
}

function readJsonValue(args: Record<string, unknown>, key: string): JsonValue {
  if (!(key in args)) {
    throw new Error(`${key} is required`);
  }
  return args[key] as JsonValue;
}

function stringifyCandidateForSafetyScan(candidate: FridayReflexCandidate): string {
  return JSON.stringify({
    title: candidate.title,
    summary: candidate.summary,
    payload: candidate.payload,
    evidence: candidate.evidence,
  }).toLowerCase();
}

function readEvidenceCount(evidence: Record<string, JsonValue>): number {
  const numericKeys = [
    "evidenceCount",
    "similarEvidenceCount",
    "supportingEvidenceCount",
    "observationCount",
    "seenCount",
  ];
  for (const key of numericKeys) {
    const value = evidence[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  for (const key of ["supportingEvidence", "observations", "examples"]) {
    const value = evidence[key];
    if (Array.isArray(value)) {
      return value.length;
    }
  }
  return 0;
}

function hasConflictEvidence(evidence: Record<string, JsonValue>): boolean {
  return evidence["conflict"] === true
    || evidence["hasConflict"] === true
    || (typeof evidence["conflictCount"] === "number" && evidence["conflictCount"] > 0);
}

function evaluateLowRiskCandidateEnvelope(
  candidate: FridayReflexCandidate,
  options: { minimumEvidenceCount: number },
): string | undefined {
  const scanned = stringifyCandidateForSafetyScan(candidate);
  if (candidate.riskTier > 1) {
    return "Candidate risk tier is too high for agent approval.";
  }
  if (candidate.confidence < 0.75) {
    return "Candidate confidence is too low for agent approval.";
  }
  if (hasConflictEvidence(candidate.evidence)) {
    return "Candidate has conflicting evidence.";
  }
  if (readEvidenceCount(candidate.evidence) < options.minimumEvidenceCount) {
    return `Candidate needs at least ${String(options.minimumEvidenceCount)} supporting observation(s).`;
  }
  if (HIGH_IMPACT_MEMORY_TERMS.some((term) => scanned.includes(term))) {
    return "Candidate touches safety, execution, permission, secret, skill, workflow, provider, MCP, or release behavior.";
  }
  return undefined;
}

function evaluateAgentReflexApproval(candidate: FridayReflexCandidate): {
  allowed: boolean;
  reason?: string;
} {
  if (candidate.kind === "preference") {
    const category = candidate.payload["category"];
    const key = candidate.payload["key"];
    const blockedReason = evaluateLowRiskCandidateEnvelope(candidate, { minimumEvidenceCount: 1 });
    if (blockedReason) {
      return { allowed: false, reason: blockedReason };
    }
    if (
      (category === "communication" || category === "uix")
      && typeof key === "string"
      && !requiresFridayReflexPreferenceConfirmation({ category, key })
    ) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "Agent approval is limited to ordinary communication/uix preferences; high-impact preferences require Review Center confirmation.",
    };
  }

  if (candidate.kind === "memory") {
    const blockedReason = evaluateLowRiskCandidateEnvelope(candidate, { minimumEvidenceCount: 2 });
    if (blockedReason) {
      return { allowed: false, reason: blockedReason };
    }
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: "Skill, workflow, fix, recipe, and test-policy candidates require Review Center confirmation.",
  };
}

export function createFridayAgentReflexTools(
  options: CreateFridayAgentReflexToolsOptions,
): FridayAgentToolDefinition[] {
  const { defaultUserId } = options;
  const getReflexService = () => {
    const service = options.reflexServiceGetter?.() ?? options.reflexService;
    if (!service) {
      throw new Error("Friday Reflex service is not available yet.");
    }
    return service;
  };
  return [
    {
      name: "reflex_candidate_list",
      description:
        "List Friday Reflex candidates awaiting review, testing, approval, rejection, or dismissal.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [...CANDIDATE_STATUSES],
            description: "Optional candidate status filter.",
          },
          kind: {
            type: "string",
            enum: [...CANDIDATE_KINDS],
            description: "Optional candidate kind filter.",
          },
          limit: {
            type: "number",
            description: "Maximum number of candidates to return.",
          },
        },
      },
      async execute(args) {
        const reflexService = getReflexService();
        const userId = resolveUserId(args, defaultUserId);
        const limit = readNumberParam(args, "limit", { integer: true }) ?? 20;
        return jsonResult({
          items: reflexService.listCandidates({
            userId,
            status: readCandidateStatus(args),
            kind: readCandidateKind(args),
            limit,
          }),
        });
      },
    },
    {
      name: "reflex_candidate_decide",
      description:
        "Test, approve, reject, or dismiss a Friday Reflex candidate through the shared review state machine.",
      parameters: {
        type: "object",
        properties: {
          candidateId: {
            type: "string",
            description: "The Reflex candidate ID.",
          },
          action: {
            type: "string",
            enum: ["test", "approve", "reject", "dismiss"],
            description: "Decision to apply.",
          },
          reason: {
            type: "string",
            description: "Optional reason for reject/dismiss.",
          },
          requestedModel: {
            type: "string",
            description: "Optional model for skill/workflow draft testing.",
          },
        },
        required: ["candidateId", "action"],
      },
      async execute(args) {
        const reflexService = getReflexService();
        const userId = resolveUserId(args, defaultUserId);
        const candidateId = readStringParam(args, "candidateId", { required: true });
        const action = readStringParam(args, "action", { required: true });
        if (action === "test") {
          return jsonResult(await reflexService.testCandidate({
            userId,
            candidateId,
            requestedModel: readStringParam(args, "requestedModel"),
          }));
        }
        if (action === "approve") {
          const candidate = reflexService.getCandidate({ userId, candidateId });
          const approval = evaluateAgentReflexApproval(candidate);
          if (!approval.allowed) {
            return jsonResult({
              status: "blocked",
              code: "REFLEX_CANDIDATE_USER_CONFIRMATION_REQUIRED",
              candidateId,
              kind: candidate.kind,
              reason: approval.reason,
            });
          }
          return jsonResult(await reflexService.approveCandidate({ userId, candidateId }));
        }
        if (action === "reject") {
          return jsonResult(reflexService.rejectCandidate({
            userId,
            candidateId,
            reason: readStringParam(args, "reason"),
          }));
        }
        if (action === "dismiss") {
          return jsonResult(reflexService.dismissCandidate({
            userId,
            candidateId,
            reason: readStringParam(args, "reason"),
          }));
        }
        throw new Error(`Invalid reflex candidate action: ${action}`);
      },
    },
    {
      name: "reflex_preference_update",
      description:
        "Immediately update a known canonical Friday preference explicitly stated by the user. " +
        "Use only when the current user clearly says to remember or change a setting.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [...PREFERENCE_CATEGORIES],
            description: "Preference category: communication, uix, or reflex.",
          },
          key: {
            type: "string",
            description: "Canonical preference key.",
          },
          value: {
            description: "Canonical preference value.",
          },
          sourceSurface: {
            type: "string",
            enum: [...SURFACES],
            description: "Surface where the explicit preference was stated. Review Center confirmation is handled by candidate approval.",
          },
        },
        required: ["category", "key", "value"],
      },
      async execute(args) {
        const reflexService = getReflexService();
        const userId = resolveUserId(args, defaultUserId);
        return jsonResult(reflexService.requestPreferenceUpdate({
          userId,
          category: readPreferenceCategory(args),
          key: readStringParam(args, "key", { required: true }),
          value: readJsonValue(args, "value"),
          sourceSurface: readSurface(args),
        }));
      },
    },
  ];
}
