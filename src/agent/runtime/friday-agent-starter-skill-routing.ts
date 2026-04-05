import type { FridayAgentToolCallRecord } from "../model/friday-agent.types.js";

export interface FridayAgentStarterSkillDescriptor {
  skillId: string;
  purpose: string;
  triggerPhrases: string[];
  intents?: string[];
  tags?: string[];
}

export interface FridayAgentStarterSkillRoutingConfig {
  enabled: boolean;
  skills: FridayAgentStarterSkillDescriptor[];
}

const OPERATIONAL_REQUEST_HINTS =
  /\b(run|review|check|audit|qa|test|scan|inspect|benchmark|canary|retro|release|plan|scope|diff|risk|security|ship|deploy|fix|debug|implement|execute)\b/i;
const CHINESE_OPERATIONAL_REQUEST_HINTS =
  /(运行|执行|审查|review|检查|审计|测试|qa|扫描|巡检|发布|验收|计划|实现|范围|差异|风险|安全|部署|修复|调试)/;
const INFORMATIONAL_REQUEST_HINTS =
  /\b(what|why|how|explain|summary|summarize|comparison|compare|difference|overview|translate|translation)\b/i;
const CHINESE_INFORMATIONAL_REQUEST_HINTS =
  /(什么|为什么|怎么|解释|总结|概述|对比|比较|区别|翻译)/;
const INFORMATIONAL_REQUEST_PREFIX_HINTS =
  /^(what|why|how|explain|summary|summarize|comparison|compare|difference|overview|translate|translation)\b/i;
const CHINESE_INFORMATIONAL_REQUEST_PREFIX_HINTS =
  /^(什么|为什么|怎么|解释|总结|概述|对比|比较|区别|翻译)/;

function normalizeRoutingText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function shouldBypassFridayStarterSkillRouting(task: string): boolean {
  const normalizedTask = normalizeRoutingText(task);
  if (normalizedTask.length === 0) {
    return true;
  }

  const hasOperationalHints =
    OPERATIONAL_REQUEST_HINTS.test(normalizedTask)
    || CHINESE_OPERATIONAL_REQUEST_HINTS.test(task);
  const hasInformationalHints =
    INFORMATIONAL_REQUEST_HINTS.test(normalizedTask)
    || CHINESE_INFORMATIONAL_REQUEST_HINTS.test(task)
    || /[?？]\s*$/.test(task);
  const hasInformationalPrefix =
    INFORMATIONAL_REQUEST_PREFIX_HINTS.test(normalizedTask)
    || CHINESE_INFORMATIONAL_REQUEST_PREFIX_HINTS.test(task.trim());

  if (hasInformationalPrefix) {
    return true;
  }

  return hasInformationalHints && !hasOperationalHints;
}

export function hasFridayStarterSkillRoutingEvidence(
  toolCalls: FridayAgentToolCallRecord[],
): boolean {
  return toolCalls.some((call) =>
    call.toolName === "skills_list" || call.toolName === "skill_run",
  );
}

export function findFridayStarterSkillRoutingCandidate(input: {
  task: string;
  skills: FridayAgentStarterSkillDescriptor[];
}): FridayAgentStarterSkillDescriptor | null {
  if (shouldBypassFridayStarterSkillRouting(input.task)) {
    return null;
  }

  const normalizedTask = normalizeRoutingText(input.task);
  let bestMatch: FridayAgentStarterSkillDescriptor | null = null;
  let bestScore = 0;

  for (const skill of input.skills) {
    let score = 0;
    const normalizedSkillId = normalizeRoutingText(skill.skillId);
    if (normalizedSkillId.length > 0 && normalizedTask.includes(normalizedSkillId)) {
      score = Math.max(score, 250);
    }

    for (const phrase of skill.triggerPhrases) {
      const normalizedPhrase = normalizeRoutingText(phrase);
      if (normalizedPhrase.length > 0 && normalizedTask.includes(normalizedPhrase)) {
        score = Math.max(score, 180 + Math.min(normalizedPhrase.length, 40));
      }
    }

    for (const intent of skill.intents ?? []) {
      const normalizedIntent = normalizeRoutingText(intent);
      if (normalizedIntent.length > 0 && normalizedTask.includes(normalizedIntent)) {
        score = Math.max(score, 140 + Math.min(normalizedIntent.length, 30));
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = skill;
    }
  }

  return bestScore >= 140 ? bestMatch : null;
}

export function buildFridayStarterSkillRoutingRetryPrompt(input: {
  task: string;
  candidate: FridayAgentStarterSkillDescriptor;
}): string {
  const sampleTriggers = input.candidate.triggerPhrases.slice(0, 3).join(", ");
  return [
    `The request "${input.task}" strongly matches the installed starter skill "${input.candidate.skillId}".`,
    "Do not answer directly yet.",
    "First call skills_list to verify the currently available starter skills and their readiness for this request.",
    sampleTriggers.length > 0
      ? `Matching trigger phrases for this skill include: ${sampleTriggers}.`
      : `This skill is documented as: ${input.candidate.purpose}.`,
    "After skills_list returns, either call skill_run with the chosen skill or explain briefly why no listed skill fits.",
  ].join(" ");
}
