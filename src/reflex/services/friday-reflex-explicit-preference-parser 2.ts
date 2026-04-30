import type { FridayReflexPreferenceWrite } from "../model/friday-reflex.types.js";

function cleanNickname(value: string): string | null {
  const cleaned = value
    .replace(/[。.!！?？]+$/u, "")
    .trim();
  if (cleaned.length === 0 || cleaned.length > 80) return null;
  if (/^(不要|别|不用|don't|do not)\b/iu.test(cleaned)) return null;
  return cleaned;
}

export function parseFridayReflexExplicitPreferenceMessage(
  text: string,
): FridayReflexPreferenceWrite[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const writes: FridayReflexPreferenceWrite[] = [];

  if (/(以后|以后都|以后请|今后|默认|always|from now on).*(回答|回复|response|answer).*(短一点|短些|简短|少一点|concise|brief)/iu.test(trimmed)) {
    writes.push({ category: "communication", key: "persona.verbosity", value: "concise" });
  } else if (/(以后|以后都|以后请|今后|默认|always|from now on).*(回答|回复|response|answer).*(详细|展开|长一点|多一点|detailed|longer)/iu.test(trimmed)) {
    writes.push({ category: "communication", key: "persona.verbosity", value: "detailed" });
  } else if (/(以后|以后都|以后请|今后|默认|always|from now on).*(回答|回复|response|answer).*(适中|平衡|balanced)/iu.test(trimmed)) {
    writes.push({ category: "communication", key: "persona.verbosity", value: "balanced" });
  }

  if (/(以后|以后都|以后请|今后|默认).*(表格|步骤|结构化)/u.test(trimmed)
    || /(always|from now on|default).*(table|steps|structured)/iu.test(trimmed)) {
    writes.push({ category: "communication", key: "persona.structure", value: "structured" });
  } else if (/(以后|以后都|以后请|今后|默认).*(清单|列表|要点)/u.test(trimmed)
    || /(always|from now on|default).*(list|bullets)/iu.test(trimmed)) {
    writes.push({ category: "communication", key: "persona.structure", value: "balanced" });
  }

  const zhNickname = /(?:以后|以后都|今后)?\s*(?:叫我|称呼我为|称呼我)\s*[:：]?\s*([^，。.!！?？\n]{1,80})/u.exec(trimmed);
  const enNickname = /(?:from now on\s+)?(?:call me|refer to me as)\s+([^,.!?;\n]{1,80})/iu.exec(trimmed);
  const nickname = cleanNickname(zhNickname?.[1] ?? enNickname?.[1] ?? "");
  if (nickname) {
    writes.push({ category: "reflex", key: "user.display_name", value: nickname });
  }

  if (/(以后|以后都|今后|默认).*(不要|别|不许|禁止).*(workflow|工作流)/iu.test(trimmed)
    || /(do not|don't|never).*(suggest|create|generate).*(workflow)/iu.test(trimmed)) {
    writes.push({ category: "reflex", key: "workflows.generation_policy", value: "do_not_suggest" });
  } else if (/(以后|以后都|今后|默认).*(workflow|工作流).*(草稿|候选|审核)/iu.test(trimmed)
    || /(workflow).*(draft|review candidate|approval)/iu.test(trimmed)) {
    writes.push({ category: "reflex", key: "workflows.generation_policy", value: "draft_workflow" });
  }

  if (/(以后|以后都|今后|默认).*(不要|别|不许|禁止).*(skill|技能|能力包)/iu.test(trimmed)
    || /(do not|don't|never).*(suggest|create|generate).*(skill)/iu.test(trimmed)) {
    writes.push({ category: "reflex", key: "skills.generation_policy", value: "suggest_only" });
  } else if (/(以后|以后都|今后|默认).*(skill|技能|能力包).*(草稿|候选|审核)/iu.test(trimmed)
    || /(skill).*(draft|review candidate|approval)/iu.test(trimmed)) {
    writes.push({ category: "reflex", key: "skills.generation_policy", value: "draft_for_approval" });
  }

  if (/(以后|以后都|今后|默认).*(真实模型|live llm|real model).*(先问|手动|确认|manual|ask)/iu.test(trimmed)) {
    writes.push({ category: "reflex", key: "testing.live_llm_policy", value: "manual_only" });
  } else if (/(以后|以后都|今后|默认).*(允许|可以).*(真实模型|live llm|real model).*(测试|自测|test)/iu.test(trimmed)
    || /(allow|ok to use).*(live llm|real model).*(test|testing)/iu.test(trimmed)) {
    writes.push({ category: "reflex", key: "testing.live_llm_policy", value: "allowed_with_cost_notice" });
  }

  if (/(以后|以后都|今后).*(不要|别|不许|禁止).*(记住|保存|长期记忆|memory)/iu.test(trimmed)) {
    writes.push({ category: "reflex", key: "memory.explicit_instruction_policy", value: "session_only" });
  } else if (/(以后|以后都|今后).*(记住|保存).*(直接|立即|马上)/iu.test(trimmed)
    || /(when I say remember).*(save|remember).*(immediately|directly)/iu.test(trimmed)) {
    writes.push({ category: "reflex", key: "memory.explicit_instruction_policy", value: "save_immediately" });
  }

  if (/(以后|以后都|今后).*(推测|猜测| inferred? ).*(偏好).*(审核|候选)/iu.test(trimmed)
    || /(inferred preference).*(candidate|review)/iu.test(trimmed)) {
    writes.push({ category: "reflex", key: "memory.inferred_preference_policy", value: "review_candidate" });
  } else if (/(以后|以后都|今后).*(不要|别|不许|禁止).*(推测|猜测).*(偏好)/iu.test(trimmed)
    || /(do not|don't|never).*(infer|guess).*(preference)/iu.test(trimmed)) {
    writes.push({ category: "reflex", key: "memory.inferred_preference_policy", value: "do_not_record" });
  }

  const seen = new Set<string>();
  return writes.filter((write) => {
    const key = `${write.category}:${write.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
