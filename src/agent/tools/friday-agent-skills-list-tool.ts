import type { FridayRegisteredSkill, FridaySkillRegistry } from "#skills";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

export interface CreateFridayAgentSkillsListToolDeps {
  skillRegistry: FridaySkillRegistry;
}

function scoreSkill(skill: FridayRegisteredSkill): number {
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
  if (skill.status === "installed") score += 10;
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

        const skills = deps.skillRegistry.list()
          .filter((skill) => !installedOnly || skill.status === "installed")
          .filter((skill) => !origin || skill.origin.toLowerCase() === origin)
          .filter((skill) => !tag || (skill.manifest.tags ?? []).some((value) => value.toLowerCase() === tag))
          .filter((skill) => {
            if (!query) return true;
            const searchable = [
              skill.manifest.id,
              skill.manifest.name,
              skill.manifest.description,
              ...(skill.manifest.tags ?? []),
              ...(skill.manifest.triggers.intents ?? []),
              ...(skill.manifest.triggers.phrases ?? []),
            ].join(" ").toLowerCase();
            return searchable.includes(query);
          })
          .sort((left, right) => {
            const scoreDiff = scoreSkill(right) - scoreSkill(left);
            if (scoreDiff !== 0) {
              return scoreDiff;
            }
            return left.manifest.name.localeCompare(right.manifest.name);
          });

        return jsonResult({
          count: skills.length,
          skills: skills.map((skill) => ({
            skillId: skill.manifest.id,
            name: skill.manifest.name,
            description: skill.manifest.description,
            status: skill.status,
            source: skill.source,
            origin: skill.origin,
            starter: (skill.manifest.tags ?? []).includes("starter"),
            tags: skill.manifest.tags ?? [],
            intents: skill.manifest.triggers.intents ?? [],
            phrases: skill.manifest.triggers.phrases ?? [],
            runtimeKind: skill.manifest.runtime.kind,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`Failed to list skills: ${message}`);
      }
    },
  };
}
