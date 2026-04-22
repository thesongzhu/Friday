import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  canRunFridayBundledSystemNodeSkillWithoutGate,
  evaluateFridaySkillExecutionReadiness,
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  type FridaySkillExecuteRequest,
  type FridaySkillExecutor,
  type FridaySkillRegistry,
  getFridayUnisolatedNodeSkillsDisabledMessage,
  isFridayUnisolatedNodeSkillsEnabled,
} from "#skills";
import { FRIDAY_AGENT_TOOL_TIMEOUT_MS } from "../friday-agent.constants.js";
import { evaluateFridaySkillMcpReadiness, type FridayMcpServerReadiness } from "../mcp/friday-mcp-readiness.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Options ───

export interface CreateFridayAgentSkillToolDeps {
  skillExecutor: FridaySkillExecutor;
  skillRegistry?: FridaySkillRegistry;
  listMcpServerReadiness?: () => readonly FridayMcpServerReadiness[];
}

// ─── Factory ───

export function createFridayAgentSkillTool(
  deps: CreateFridayAgentSkillToolDeps,
): FridayAgentToolDefinition {
  return {
    name: "skill_run",
    description:
      "Execute a Friday skill by ID with given input. Returns the skill output.",
    parameters: {
      properties: {
        skillId: { type: "string", description: "Skill ID to execute" },
        input: { type: "object", description: "Input parameters for the skill" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds" },
      },
      required: ["skillId", "input"],
    },
    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const skillId = readStringParam(args, "skillId", { required: true });
      const timeoutMs =
        readNumberParam(args, "timeoutMs", { integer: true }) ??
        FRIDAY_AGENT_TOOL_TIMEOUT_MS;

      const rawInput = args["input"];
      const input: Record<string, unknown> =
        rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : {};

      const request: FridaySkillExecuteRequest = {
        skillId,
        input,
        sessionId: "agent",
        userId: "agent",
        channel: "agent",
        tenantContext: {
          hubId: "default",
          userId: "agent",
          channelKind: "agent",
        },
        timeoutMs,
      };

      const registeredSkill = deps.skillRegistry?.get(skillId);
      if (registeredSkill) {
        const requiredInputs = (registeredSkill.manifest.inputs ?? [])
          .filter((field) =>
            field.required !== false
            && field.defaultValue === undefined
            && typeof field.key === "string"
            && field.key.trim().length > 0,
          )
          .map((field) => ({
            key: field.key.trim(),
            type: field.type,
            label: field.label,
          }));
        const missingInputs = requiredInputs
          .filter((field) => {
            const value = input[field.key];
            if (value == null) return true;
            return typeof value === "string" && value.trim().length === 0;
          });
        if (missingInputs.length > 0) {
          const exampleInput = Object.fromEntries(
            requiredInputs.map((field) => [
              field.key,
              field.type === "number"
                ? 0
                : field.type === "boolean"
                  ? true
                  : field.type === "array"
                    ? []
                    : field.type === "object"
                      ? {}
                      : `<${field.key}>`,
            ]),
          );
          return errorResult(
            `Skill '${skillId}' missing required input(s): ${missingInputs.map((field) => field.key).join(", ")}. Provide input like ${JSON.stringify(exampleInput)}.`,
          );
        }

        const mcpReadiness = evaluateFridaySkillMcpReadiness({
          manifest: registeredSkill.manifest,
          servers: deps.listMcpServerReadiness?.() ?? [],
        });
        const runtimeReadiness = evaluateFridaySkillExecutionReadiness({
          manifest: registeredSkill.manifest,
        });
        const allowBundledSystemNodeSkill = canRunFridayBundledSystemNodeSkillWithoutGate({
          runtimeKind: registeredSkill.manifest.runtime.kind,
          manifestKind: registeredSkill.manifest.kind,
          source: registeredSkill.source,
          origin: registeredSkill.origin,
        });
        const nodeRuntimeBlocked =
          registeredSkill.manifest.runtime.kind === "node"
          && !allowBundledSystemNodeSkill
          && !isFridayUnisolatedNodeSkillsEnabled();
        if (nodeRuntimeBlocked) {
          return jsonResult({
            skillId,
            status: "blocked",
            ready: false,
            code: "CAPABILITY_DISABLED",
            capability: "skill_node_runtime",
            surface: "skill_run",
            blockers: [getFridayUnisolatedNodeSkillsDisabledMessage()],
            details: {
              runtimeKind: "node",
              gate: FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
            },
          });
        }
        const blockers = [
          ...mcpReadiness.blockers,
          ...runtimeReadiness.blockers,
        ];
        const requirements = {
          ...(runtimeReadiness.requirements ?? {}),
          ...(mcpReadiness.requirements ?? {}),
        };
        if (blockers.length > 0) {
          return jsonResult({
            skillId,
            status: "blocked",
            ready: false,
            blockers,
            ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
          });
        }
      }

      const handle = deps.skillExecutor.execute(request);

      // Race the skill result against the abort signal
      const result = await Promise.race([
        handle.result,
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            deps.skillExecutor.cancel(handle.runId);
            reject(new Error("Skill execution aborted"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              deps.skillExecutor.cancel(handle.runId);
              reject(new Error("Skill execution aborted"));
            },
            { once: true },
          );
        }),
      ]);

      if (result.status !== "completed") {
        return errorResult(
          `Skill '${skillId}' ${result.status}: ${result.stderr || "unknown error"}`,
        );
      }

      return jsonResult({
        runId: result.runId,
        status: result.status,
        output: result.output,
        durationMs: result.durationMs,
      });
    },
  };
}
