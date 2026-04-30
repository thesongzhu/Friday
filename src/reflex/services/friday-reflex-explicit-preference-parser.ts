import type { FridayReflexPreferenceWrite } from "../model/friday-reflex.types.js";

interface ExplicitPreferenceRule {
  pattern: RegExp;
  write: FridayReflexPreferenceWrite;
}

const EXPLICIT_PREFERENCE_RULES: readonly ExplicitPreferenceRule[] = [
  {
    pattern: /(以后|以后都|以后请|今后|默认|always|from now on).*(回答|回复|response|answer).*(短一点|短些|简短|少一点|concise|brief)/iu,
    write: { category: "communication", key: "persona.verbosity", value: "concise" },
  },
  {
    pattern: /(以后|以后都|以后请|今后|默认|always|from now on).*(回答|回复|response|answer).*(详细|展开|长一点|多一点|detailed|longer)/iu,
    write: { category: "communication", key: "persona.verbosity", value: "detailed" },
  },
  {
    pattern: /(以后|以后都|以后请|今后|默认|always|from now on).*(回答|回复|response|answer).*(适中|平衡|balanced)/iu,
    write: { category: "communication", key: "persona.verbosity", value: "balanced" },
  },
  {
    pattern: /(以后|以后都|以后请|今后|默认).*(表格|步骤|结构化)|(always|from now on|default).*(table|steps|structured)/iu,
    write: { category: "communication", key: "persona.structure", value: "structured" },
  },
  {
    pattern: /(以后|以后都|以后请|今后|默认).*(清单|列表|要点)|(always|from now on|default).*(list|bullets)/iu,
    write: { category: "communication", key: "persona.structure", value: "balanced" },
  },
  {
    pattern: /(以后|以后都|今后|默认).*(不要|别|不许|禁止).*(workflow|工作流)|(do not|don't|never).*(suggest|create|generate).*(workflow)/iu,
    write: { category: "reflex", key: "workflows.generation_policy", value: "do_not_suggest" },
  },
  {
    pattern: /(以后|以后都|今后|默认).*(workflow|工作流).*(草稿|候选|审核)|(workflow).*(draft|review candidate|approval)/iu,
    write: { category: "reflex", key: "workflows.generation_policy", value: "draft_workflow" },
  },
  {
    pattern: /(以后|以后都|今后|默认).*(不要|别|不许|禁止).*(skill|技能|能力包)|(do not|don't|never).*(suggest|create|generate).*(skill)/iu,
    write: { category: "reflex", key: "skills.generation_policy", value: "suggest_only" },
  },
  {
    pattern: /(以后|以后都|今后|默认).*(skill|技能|能力包).*(草稿|候选|审核)|(skill).*(draft|review candidate|approval)/iu,
    write: { category: "reflex", key: "skills.generation_policy", value: "draft_for_approval" },
  },
  {
    pattern: /(以后|以后都|今后|默认).*(真实模型|live llm|real model).*(先问|手动|确认|manual|ask)/iu,
    write: { category: "reflex", key: "testing.live_llm_policy", value: "manual_only" },
  },
  {
    pattern: /(以后|以后都|今后|默认).*(允许|可以).*(真实模型|live llm|real model).*(测试|自测|test)|(allow|ok to use).*(live llm|real model).*(test|testing)/iu,
    write: { category: "reflex", key: "testing.live_llm_policy", value: "allowed_with_cost_notice" },
  },
  {
    pattern: /(以后|以后都|今后).*(不要|别|不许|禁止).*(记住|保存|长期记忆|memory)/iu,
    write: { category: "reflex", key: "memory.explicit_instruction_policy", value: "session_only" },
  },
  {
    pattern: /(以后|以后都|今后).*(记住|保存).*(直接|立即|马上)|(when I say remember).*(save|remember).*(immediately|directly)/iu,
    write: { category: "reflex", key: "memory.explicit_instruction_policy", value: "save_immediately" },
  },
  {
    pattern: /(以后|以后都|今后).*(推测|猜测).*(偏好).*(审核|候选)|(inferred preference).*(candidate|review)/iu,
    write: { category: "reflex", key: "memory.inferred_preference_policy", value: "review_candidate" },
  },
  {
    pattern: /(以后|以后都|今后).*(不要|别|不许|禁止).*(推测|猜测).*(偏好)|(do not|don't|never).*(infer|guess).*(preference)/iu,
    write: { category: "reflex", key: "memory.inferred_preference_policy", value: "do_not_record" },
  },
];

function cleanNickname(value: string | undefined): string | null {
  const cleaned = value
    ?.replace(/[。.!！?？]+$/u, "")
    .trim();
  if (!cleaned || cleaned.length > 80) return null;
  if (/^(不要|别|不用|don't|do not)\b/iu.test(cleaned)) return null;
  return cleaned;
}

function parseNickname(text: string): FridayReflexPreferenceWrite | null {
  const zhNickname = /(?:以后|以后都|今后)?\s*(?:叫我|称呼我为|称呼我)\s*[:：]?\s*([^，。.!！?？\n]{1,80})/u.exec(text);
  const enNickname = /(?:from now on\s+)?(?:call me|refer to me as)\s+([^,.!?;\n]{1,80})/iu.exec(text);
  const nickname = cleanNickname(zhNickname?.[1] ?? enNickname?.[1]);
  return nickname
    ? { category: "reflex", key: "user.display_name", value: nickname }
    : null;
}

export function parseFridayReflexExplicitPreferenceMessage(
  text: string,
): FridayReflexPreferenceWrite[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const writes = EXPLICIT_PREFERENCE_RULES
    .filter((rule) => rule.pattern.test(trimmed))
    .map((rule) => rule.write);
  const nickname = parseNickname(trimmed);
  if (nickname) writes.push(nickname);

  const seen = new Set<string>();
  return writes.filter((write) => {
    const key = `${write.category}:${write.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
