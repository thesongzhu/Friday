import type {
  FridayReflexCandidateKind,
  FridayReflexCandidateStatus,
  FridayReflexService,
  FridayReflexSurface,
} from "../../reflex/index.js";
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
