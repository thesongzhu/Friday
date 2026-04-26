import type {
  FridayAutonomyPolicyService,
  FridayCapabilityAcquisitionService,
  FridayStandingAgendaService,
} from "../../autonomy/index.js";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import { FRIDAY_RUNTIME_CAPABILITY_IDS, type FridayRuntimeCapabilityId } from "#providers";

export interface CreateFridayAgentControlledAutonomyToolDeps {
  policyService: FridayAutonomyPolicyService;
  acquisitionService: FridayCapabilityAcquisitionService;
  standingAgendaService: FridayStandingAgendaService;
  defaultUserId?: string;
}

type ControlledAutonomyAction =
  | "policy_get"
  | "policy_update"
  | "acquisition_plan"
  | "acquisition_start"
  | "acquisition_approve"
  | "acquisition_cancel"
  | "standing_goal_create"
  | "standing_goal_update"
  | "agenda_list"
  | "agenda_approve"
  | "agenda_run";

const VALID_ACTIONS = new Set<ControlledAutonomyAction>([
  "policy_get",
  "policy_update",
  "acquisition_plan",
  "acquisition_start",
  "acquisition_approve",
  "acquisition_cancel",
  "standing_goal_create",
  "standing_goal_update",
  "agenda_list",
  "agenda_approve",
  "agenda_run",
]);

const CAPABILITY_SET = new Set<string>(FRIDAY_RUNTIME_CAPABILITY_IDS);

export function createFridayAgentControlledAutonomyTool(
  deps: CreateFridayAgentControlledAutonomyToolDeps,
): FridayAgentToolDefinition {
  const defaultUserId = deps.defaultUserId ?? "system";
  return {
    name: "controlled_autonomy",
    description:
      "Controlled AGI-like autonomy control plane. Use it to answer and execute: " +
      "what capability is missing, how to acquire it, whether human setup is needed, how to approve/register verified candidates, " +
      "and how standing goals create agenda runs with evidence and strategy-only learning. " +
      "It never treats missing API keys, OAuth, login, CAPTCHA, payment, or sensitive permissions as automatically solved.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...VALID_ACTIONS],
        },
        goal: {
          type: "string",
          description: "User goal for acquisition planning or standing goal creation.",
        },
        runId: {
          type: "string",
          description: "Capability acquisition run ID.",
        },
        agendaItemId: {
          type: "string",
          description: "Agenda item ID.",
        },
        standingGoalId: {
          type: "string",
          description: "Standing goal ID.",
        },
        userId: {
          type: "string",
          description: "User ID. Defaults to the hub learning user.",
        },
        requiredCapabilities: {
          type: "array",
          items: { type: "string", enum: [...FRIDAY_RUNTIME_CAPABILITY_IDS] },
          description: "Optional explicit capability IDs.",
        },
        readOnly: {
          type: "boolean",
          description: "Whether the acquisition plan should assume read-only runtime.",
        },
        mode: {
          type: "string",
          enum: ["low_risk_auto", "max_autonomy"],
          description: "Policy mode for policy_update.",
        },
        paused: {
          type: "boolean",
          description: "Pause or resume autonomy for policy_update.",
        },
        title: {
          type: "string",
          description: "Standing goal title.",
        },
        status: {
          type: "string",
          description: "Standing goal status or agenda list status filter.",
        },
      },
      required: ["action"],
    },
    async execute(args): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as ControlledAutonomyAction;
      if (!VALID_ACTIONS.has(action)) {
        return errorResult(`Invalid action "${action}". Valid actions: ${[...VALID_ACTIONS].join(", ")}`);
      }
      try {
        switch (action) {
          case "policy_get":
            return jsonResult({ policy: deps.policyService.getPolicy() });
          case "policy_update":
            return jsonResult({
              policy: deps.policyService.updatePolicy({
                mode: readStringParam(args, "mode") as "low_risk_auto" | "max_autonomy" | undefined,
                paused: readBooleanParam(args, "paused"),
              }),
            });
          case "acquisition_plan":
            return jsonResult({
              run: await deps.acquisitionService.plan({
                userId: readStringParam(args, "userId") ?? defaultUserId,
                goal: readStringParam(args, "goal", { required: true }),
                requiredCapabilities: readCapabilities(args.requiredCapabilities),
                readOnly: readBooleanParam(args, "readOnly"),
              }),
            });
          case "acquisition_start":
            return jsonResult({
              run: await deps.acquisitionService.startRun({
                userId: readStringParam(args, "userId") ?? defaultUserId,
                goal: readStringParam(args, "goal", { required: true }),
                requiredCapabilities: readCapabilities(args.requiredCapabilities),
                readOnly: readBooleanParam(args, "readOnly"),
              }),
            });
          case "acquisition_approve":
            return jsonResult({
              run: await deps.acquisitionService.approveRun(readStringParam(args, "runId", { required: true })),
            });
          case "acquisition_cancel":
            return jsonResult({
              run: deps.acquisitionService.cancelRun(readStringParam(args, "runId", { required: true })),
            });
          case "standing_goal_create": {
            const result = await deps.standingAgendaService.createStandingGoal({
              userId: readStringParam(args, "userId") ?? defaultUserId,
              objective: readStringParam(args, "goal", { required: true }),
              title: readStringParam(args, "title"),
            });
            return jsonResult(result);
          }
          case "standing_goal_update":
            return jsonResult({
              goal: deps.standingAgendaService.updateStandingGoal(
                readStringParam(args, "standingGoalId", { required: true }),
                {
                  title: readStringParam(args, "title"),
                  objective: readStringParam(args, "goal"),
                  status: readStringParam(args, "status") as never,
                },
              ),
            });
          case "agenda_list":
            return jsonResult({
              items: deps.standingAgendaService.listAgenda({
                userId: readStringParam(args, "userId") ?? defaultUserId,
                status: readStringParam(args, "status"),
              }),
            });
          case "agenda_approve":
            return jsonResult({
              item: deps.standingAgendaService.approveAgendaItem({
                agendaItemId: readStringParam(args, "agendaItemId", { required: true }),
                userId: readStringParam(args, "userId") ?? defaultUserId,
              }),
            });
          case "agenda_run":
            return jsonResult({
              run: await deps.standingAgendaService.runAgendaItem({
                agendaItemId: readStringParam(args, "agendaItemId", { required: true }),
                userId: readStringParam(args, "userId") ?? defaultUserId,
              }),
            });
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function readCapabilities(raw: unknown): FridayRuntimeCapabilityId[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const capabilities = raw
    .map((item) => typeof item === "string" ? item : "")
    .filter((item): item is FridayRuntimeCapabilityId => CAPABILITY_SET.has(item));
  return capabilities.length > 0 ? capabilities : undefined;
}
