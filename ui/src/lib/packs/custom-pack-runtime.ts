import { localize, resolveLocalizedText, type AppLocale } from "@/lib/i18n/localized-text";
import type { CustomPackInput, FridayPackDefinition } from "./pack-registry";
import { buildCustomPackId } from "./pack-registry";

export function isCustomPackDefinition(pack: FridayPackDefinition): boolean {
  return !pack.builtIn && pack.id.startsWith("custom-");
}

export function findCustomPackInputByPackId(
  customPackInputs: CustomPackInput[],
  packId: string,
): CustomPackInput | null {
  return customPackInputs.find((input, index) => buildCustomPackId(input, index) === packId) ?? null;
}

export function buildAgentRunHref(runId: string): string {
  return `/command-center?runId=${encodeURIComponent(runId)}`;
}

export function buildCustomPackDisplayTask(
  input: CustomPackInput,
  pack: FridayPackDefinition,
  locale: AppLocale,
): string {
  const packTitle = resolveLocalizedText(pack.title, locale);
  const description = locale === "zh"
    ? input.description.trim() || resolveLocalizedText(pack.summary, locale)
    : input.descriptionEn.trim() || input.description.trim() || resolveLocalizedText(pack.summary, locale);

  return localize(
    locale,
    `执行自创任务「${packTitle}」。${description}`,
    `Run the custom task "${packTitle}". ${description}`,
  );
}

export function buildCustomPackAdjustPrompt(
  input: CustomPackInput,
  pack: FridayPackDefinition,
  locale: AppLocale,
): string {
  const preferredPrompt = input.entryPrompts.find((prompt) => prompt.trim().length > 0)?.trim();
  if (preferredPrompt) {
    return preferredPrompt;
  }

  return localize(
    locale,
    `我想先细化我的自创任务「${resolveLocalizedText(pack.title, locale)}」。背景：${input.description.trim() || resolveLocalizedText(pack.summary, locale)}。请先帮我整理目标、缺失信息和最合理的下一步。`,
    `I want to refine my custom task "${resolveLocalizedText(pack.title, locale)}". Context: ${input.descriptionEn.trim() || input.description.trim() || resolveLocalizedText(pack.summary, locale)}. First, organize the goal, missing inputs, and the best next step.`,
  );
}

export function buildCustomPackStartTask(
  input: CustomPackInput,
  pack: FridayPackDefinition,
  locale: AppLocale,
): string {
  const packTitle = resolveLocalizedText(pack.title, locale);
  const description = locale === "zh"
    ? input.description.trim() || resolveLocalizedText(pack.summary, locale)
    : input.descriptionEn.trim() || input.description.trim() || resolveLocalizedText(pack.summary, locale);
  const preferredSkills = input.skillIds.length > 0
    ? input.skillIds.join(", ")
    : localize(locale, "无特定技能约束", "No specific skill constraint");
  const starterPrompts = input.entryPrompts
    .map((prompt) => prompt.trim())
    .filter((prompt) => prompt.length > 0);

  if (locale === "zh") {
    return [
      `执行用户自创任务包「${packTitle}」。`,
      `任务说明：${description}`,
      `优先技能：${preferredSkills}`,
      starterPrompts.length > 0
        ? `优先从这些用户定义的入口组织工作：${starterPrompts.map((prompt, index) => `${index + 1}. ${prompt}`).join(" ")}`
        : "当前没有预设入口语句，请直接根据任务说明推进。",
      "这是一个已经保存好的用户自创任务，请把上面的任务说明当作当前运行的真实 brief。",
      "如果这个任务已经有真实上下文、历史运行结果或当前会话证据，直接沿着这些真实数据继续，不要改写成通用模板。",
      "回答时只引用这份任务 brief 和真实运行记录，不要复述内部实现、存储结构或调试字段。",
      "如果缺少关键输入，只问最少的问题；如果已经足够开始，就直接给出可执行结果。",
      "输出必须包含：当前判断、下一步动作、需要补充的数据（如果有）。",
    ].join("\n");
  }

  return [
    `Execute the user's custom pack "${packTitle}".`,
    `Pack brief: ${description}`,
    `Preferred skills: ${preferredSkills}`,
    starterPrompts.length > 0
      ? `Organize the work from these user-defined starters: ${starterPrompts.map((prompt, index) => `${index + 1}. ${prompt}`).join(" ")}`
      : "There are no starter prompts, so proceed directly from the pack brief.",
    "This is an already-saved user custom task. Treat the brief above as the real source of truth for the current run.",
    "If this pack already has real context, prior run output, or live session evidence, continue from that real data instead of turning it into a generic template.",
    "In the user-facing answer, refer only to the pack brief and live run evidence. Do not surface storage details, internal identifiers, or debugging notes.",
    "Only ask clarifying questions when blocked on critical missing input. Otherwise, move straight into actionable output.",
    "Your output must include: current judgment, next actions, and missing data if any.",
  ].join("\n");
}
