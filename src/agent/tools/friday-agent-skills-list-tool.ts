import {
  canRunFridayBundledSystemNodeSkillWithoutGate,
  evaluateFridaySkillExecutionReadiness,
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  type FridayRegisteredSkill,
  type FridaySkillRegistry,
  getFridayUnisolatedNodeSkillsDisabledMessage,
  isFridayUnisolatedNodeSkillsEnabled,
  type SkillLifecycleStatus,
} from "#skills";
import { evaluateFridaySkillMcpReadiness, type FridayMcpServerReadiness } from "../mcp/friday-mcp-readiness.js";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

export interface CreateFridayAgentSkillsListToolDeps {
  skillRegistry: FridaySkillRegistry;
  listMcpServerReadiness?: () => readonly FridayMcpServerReadiness[];
  getSkillLifecycleStatus?: (skillId: string) => SkillLifecycleStatus | null | undefined;
}

function scoreSkill(skill: FridayRegisteredSkill, lifecycleStatus: SkillLifecycleStatus): number {
  const tags = skill.manifest.tags ?? [];
  let score = 0;
  if (tags.includes("starter")) score += 100;
  if (tags.includes("starter.cli")) score += 28;
  if (tags.includes("starter.recovery")) score += 35;
  if (tags.includes("starter.diagnosis")) score += 30;
  if (tags.includes("starter.builder")) score += 20;
  if (tags.includes("starter.qa")) score += 18;
  if (tags.includes("starter.release")) score += 16;
  if (tags.includes("starter.security")) score += 14;
  if (tags.includes("starter.retro")) score += 12;
  if (tags.includes("starter.devops")) score += 10;
  if (tags.includes("cli-backed")) score += 8;
  if (tags.includes("skill.stabilized")) score += 6;
  if (lifecycleStatus === "installed") score += 10;
  if (skill.origin === "bundled") score += 5;
  return score;
}

export function createFridayAgentSkillsListTool(
  deps: CreateFridayAgentSkillsListToolDeps,
): FridayAgentToolDefinition {
  return {
    name: "skills_list",
    description:
      "List currently available Friday skills before calling skill_run. " +
      "Supports filtering by installed status, origin, tag, and free-text query.",
    parameters: {
      properties: {
        installedOnly: {
          type: "boolean",
          description: "If true, only return skills that are currently installed/enabled.",
        },
        origin: {
          type: "string",
          description: "Optional origin filter such as bundled, managed, workspace, or extra.",
        },
        tag: {
          type: "string",
          description: "Optional manifest tag filter, for example starter or starter.devops.",
        },
        q: {
          type: "string",
          description: "Optional free-text query against skill id, name, description, tags, intents, and phrases.",
        },
      },
    },
    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      try {
        const installedOnly = readBooleanParam(args, "installedOnly") ?? false;
        const origin = readStringParam(args, "origin")?.toLowerCase();
        const tag = readStringParam(args, "tag")?.toLowerCase();
        const query = readStringParam(args, "q")?.toLowerCase();
        const mcpServers = deps.listMcpServerReadiness?.() ?? [];

        const skills = deps.skillRegistry.list()
          .map((skill) => ({
            skill,
            lifecycleStatus: deps.getSkillLifecycleStatus?.(skill.manifest.id) ?? skill.status,
          }))
          .filter((entry) => !installedOnly || entry.lifecycleStatus === "installed")
          .filter((entry) => !origin || entry.skill.origin.toLowerCase() === origin)
          .filter((entry) => !tag || (entry.skill.manifest.tags ?? []).some((value) => value.toLowerCase() === tag))
          .filter((entry) => {
            if (!query) return true;
            const searchable = [
              entry.skill.manifest.id,
              entry.skill.manifest.name,
              entry.skill.manifest.description,
              ...(entry.skill.manifest.tags ?? []),
              ...(entry.skill.manifest.triggers.intents ?? []),
              ...(entry.skill.manifest.triggers.phrases ?? []),
            ].join(" ").toLowerCase();
            return searchable.includes(query);
          })
          .sort((left, right) => {
            const scoreDiff = scoreSkill(right.skill, right.lifecycleStatus) - scoreSkill(left.skill, left.lifecycleStatus);
            if (scoreDiff !== 0) {
              return scoreDiff;
            }
            return left.skill.manifest.name.localeCompare(right.skill.manifest.name);
          });

        return jsonResult({
          count: skills.length,
          skills: skills.map(({ skill, lifecycleStatus }) => {
            const mcpReadiness = evaluateFridaySkillMcpReadiness({
              manifest: skill.manifest,
              servers: mcpServers,
            });
            const runtimeReadiness = evaluateFridaySkillExecutionReadiness({
              manifest: skill.manifest,
            });
            const allowBundledSystemNodeSkill = canRunFridayBundledSystemNodeSkillWithoutGate({
              runtimeKind: skill.manifest.runtime.kind,
              manifestKind: skill.manifest.kind,
              source: skill.source,
              origin: skill.origin,
            });
            const nodeRuntimeBlocked =
              skill.manifest.runtime.kind === "node"
              && !allowBundledSystemNodeSkill
              && !isFridayUnisolatedNodeSkillsEnabled();
            const lifecycleBlocked = lifecycleStatus !== "installed";
            const blockers = [
              ...(lifecycleBlocked ? ["Skill is not available until it is installed and promoted."] : []),
              ...mcpReadiness.blockers,
              ...runtimeReadiness.blockers,
              ...(nodeRuntimeBlocked ? [getFridayUnisolatedNodeSkillsDisabledMessage()] : []),
            ];
            const requirements = {
              ...(runtimeReadiness.requirements ?? {}),
              ...(mcpReadiness.requirements ?? {}),
            };

            return {
              skillId: skill.manifest.id,
              name: skill.manifest.name,
              description: skill.manifest.description,
              status: lifecycleStatus,
              source: skill.source,
              origin: skill.origin,
              starter: (skill.manifest.tags ?? []).includes("starter"),
              tags: skill.manifest.tags ?? [],
              intents: skill.manifest.triggers.intents ?? [],
              phrases: skill.manifest.triggers.phrases ?? [],
              runtimeKind: skill.manifest.runtime.kind,
              ready: blockers.length === 0,
              blockers,
              ...(nodeRuntimeBlocked
                ? {
                    details: {
                      runtimeKind: "node",
                      gate: FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
                    },
                  }
                : {}),
              ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
            };
          }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`Failed to list skills: ${message}`);
      }
    },
  };
}
