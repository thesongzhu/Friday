import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import { FridayDomainError } from "#errors";
import {
  canRunFridayBundledSystemNodeSkillWithoutGate,
  evaluateFridaySkillExecutionReadiness,
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  type FridaySkillExecuteRequest,
  type FridaySkillExecutor,
  type FridaySkillRegistry,
  getFridayUnisolatedNodeSkillsDisabledMessage,
  isFridayUnisolatedNodeSkillsEnabled,
  type SkillLifecycleStatus,
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
  getSkillLifecycleStatus?: (skillId: string) => SkillLifecycleStatus | null | undefined;
  /**
   * TS Runtime Retirement — OF6 method-level fail-closed guard. The agent
   * `skill_run` tool is a NON-route caller that reaches the shared
   * `skillExecutor.execute` arbitrary-code sink (shell/python/node) keyed by an
   * ARBITRARY caller-supplied skillId. The public skill route is already fenced
   * by `allowTestOnlySkillRunExecution` at friday-skill-routes.ts; this is the
   * SAME flag for the whole skill-run retirement surface. Default-undefined →
   * OFF → skill runs fail closed (the intended retired state in production).
   * Only the test oracle (or a future Rust-owned entrypoint flip) sets it true.
   * The `ai-inference` BYOK shortcut is exempt below (it short-circuits to the
   * provider service inside the executor and never reaches the code sink).
   */
  allowTestOnlySkillRunExecution?: boolean;
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

      // ─── TS Runtime Retirement — OF6 method-level fail-closed guard ───
      // This NON-route caller reaches the shared `skillExecutor.execute`
      // arbitrary-code sink with a caller-supplied skillId. Fail closed unless
      // the test oracle (or a future Rust-owned entrypoint) opts in via the same
      // flag the skill route uses. EXEMPT `ai-inference`: that skillId
      // short-circuits to the provider service inside the executor
      // (friday-skill-executor.ts ai-inference shortcut) and returns BEFORE any
      // shell/python/node sink — it is a fixed (non-arbitrary) BYOK path that
      // must stay live, so guarding it would wrongly retire provider inference.
      if (
        skillId !== "ai-inference"
        && deps.allowTestOnlySkillRunExecution !== true
      ) {
        throw new FridayDomainError(
          "TS_RUNTIME_SKILL_RUNS_RETIRED",
          "Skill run execution is fail-closed while runtime ownership is being moved out of TypeScript.",
          {
            httpStatus: 503,
            details: {
              classification: "fail_closed",
              replacement: "rust_owned_skill_run_entrypoint_required",
            },
          },
        );
      }

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

      const persistedLifecycleStatus = deps.getSkillLifecycleStatus?.(skillId);
      const registeredSkill = deps.skillRegistry?.get(skillId);
      if (persistedLifecycleStatus && persistedLifecycleStatus !== "installed") {
        return jsonResult({
          skillId,
          status: "blocked",
          ready: false,
          code: "SKILL_NOT_AVAILABLE",
          lifecycleStatus: persistedLifecycleStatus,
          blockers: ["Skill is not available until it is installed and promoted."],
        });
      }
      if (registeredSkill) {
        const lifecycleStatus = persistedLifecycleStatus ?? registeredSkill.status;
        if (lifecycleStatus !== "installed") {
          return jsonResult({
            skillId,
            status: "blocked",
            ready: false,
            code: "SKILL_NOT_AVAILABLE",
            lifecycleStatus,
            blockers: ["Skill is not available until it is installed and promoted."],
          });
        }
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
        if (registeredSkill.origin === "managed" && registeredSkill.source !== "bundled") {
          return jsonResult({
            skillId,
            status: "blocked",
            ready: false,
            code: "SKILL_RUN_APPROVAL_REQUIRED",
            blockers: ["External skill execution requires canonical approval after promotion."],
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
