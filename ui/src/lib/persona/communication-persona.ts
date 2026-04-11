import type {
  FridayCommunicationMbti,
  FridayCommunicationPersona,
  FridayCommunicationPersonaSettings,
} from "@friday-operator-client";

export const COMMUNICATION_MBTI_OPTIONS: readonly FridayCommunicationMbti[] = [
  "INTJ", "INTP", "ENTJ", "ENTP",
  "INFJ", "INFP", "ENFJ", "ENFP",
  "ISTJ", "ISFJ", "ESTJ", "ESFJ",
  "ISTP", "ISFP", "ESTP", "ESFP",
];

export const DEFAULT_COMMUNICATION_SETTINGS: FridayCommunicationPersonaSettings = {
  tone: "neutral",
  verbosity: "balanced",
  structure: "balanced",
  questionStyle: "guided",
  directness: "balanced",
  emojiStyle: "none",
  jargonTolerance: "medium",
  assumptionStyle: "balanced",
  confirmationStyle: "balanced",
};

const MBTI_TEMPLATE_MAP: Record<FridayCommunicationMbti, FridayCommunicationPersonaSettings> = {
  INTJ: { tone: "analytical", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "minimal" },
  INTP: { tone: "analytical", verbosity: "detailed", structure: "structured", questionStyle: "exploratory", directness: "balanced", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "balanced" },
  ENTJ: { tone: "analytical", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "explicit" },
  ENTP: { tone: "analytical", verbosity: "balanced", structure: "balanced", questionStyle: "exploratory", directness: "direct", emojiStyle: "light", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "minimal" },
  INFJ: { tone: "warm", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "medium", assumptionStyle: "balanced", confirmationStyle: "explicit" },
  INFP: { tone: "warm", verbosity: "detailed", structure: "balanced", questionStyle: "guided", directness: "soft", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "explicit" },
  ENFJ: { tone: "encouraging", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "medium", assumptionStyle: "balanced", confirmationStyle: "explicit" },
  ENFP: { tone: "encouraging", verbosity: "balanced", structure: "balanced", questionStyle: "exploratory", directness: "balanced", emojiStyle: "light", jargonTolerance: "medium", assumptionStyle: "balanced", confirmationStyle: "balanced" },
  ISTJ: { tone: "neutral", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "medium", assumptionStyle: "ask_first", confirmationStyle: "explicit" },
  ISFJ: { tone: "warm", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "soft", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "explicit" },
  ESTJ: { tone: "neutral", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "medium", assumptionStyle: "infer_first", confirmationStyle: "explicit" },
  ESFJ: { tone: "encouraging", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "explicit" },
  ISTP: { tone: "neutral", verbosity: "concise", structure: "compact", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "minimal" },
  ISFP: { tone: "warm", verbosity: "balanced", structure: "compact", questionStyle: "guided", directness: "soft", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "balanced" },
  ESTP: { tone: "neutral", verbosity: "concise", structure: "compact", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "medium", assumptionStyle: "infer_first", confirmationStyle: "minimal" },
  ESFP: { tone: "encouraging", verbosity: "balanced", structure: "balanced", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "balanced", confirmationStyle: "balanced" },
};

export function getMbtiDefaults(mbti: FridayCommunicationMbti | null): FridayCommunicationPersonaSettings {
  return mbti ? { ...MBTI_TEMPLATE_MAP[mbti] } : { ...DEFAULT_COMMUNICATION_SETTINGS };
}

/** Per-MBTI unique preview samples so every type feels distinct. */
const MBTI_PREVIEW_ZH: Record<FridayCommunicationMbti, [string, string]> = {
  INTJ: ["已分析完毕。方案 A 风险最低，建议直接执行。需要我开始吗？", "这个操作会修改生产配置。确认后我立即执行。"],
  INTP: ["我注意到这个问题有三种可能的根因。我先列出来，你看哪个方向值得深挖？", "这个改动可能有连锁影响，我先跑个模拟再决定。"],
  ENTJ: ["目标明确，我已规划好 3 步执行路径。直接开始？", "这需要审批。批准后我会一次性完成，不中断。"],
  ENTP: ["有个更有趣的思路——如果我们换个角度，用 API 直接拉数据会不会更快？", "这条路有风险，但值得试。需要你先点头。"],
  INFJ: ["我理解你想要的效果。我会按照你的节奏来，先从最安全的部分开始。", "这一步比较敏感，我想先确认你的想法再动手。"],
  INFP: ["这个想法很好呢。我来帮你把它变成可以落地的方案，你觉得从哪里开始比较舒服？", "这个操作有些风险，你希望我怎么处理呢？"],
  ENFJ: ["很棒的目标！我建议分三步走，每步我都会确认进展。准备好了吗？", "这需要你的批准。放心，我会解释每一步在做什么。"],
  ENFP: ["好主意！我想到了好几种实现方式。先试最快的那个？", "这个有点冒险，但潜力很大。你说了算！"],
  ISTJ: ["收到。按照标准流程，我先检查前置条件，然后逐步执行。", "这需要审批。流程要求先确认再操作。"],
  ISFJ: ["好的，我会仔细处理的。先帮你备份一下当前状态，然后再开始改动。", "这个操作会影响现有数据，我想先跟你确认一下。"],
  ESTJ: ["明白。任务已拆解，预计 3 分钟完成。开始。", "这超出了自动执行范围，需要你批准。"],
  ESFJ: ["我来帮你安排好。先处理最紧急的部分，其他的我们一起排个优先级？", "这一步需要你同意，我会确保不会影响到其他人。"],
  ISTP: ["可以。用哪个项目？", "这个有风险，需要你确认。"],
  ISFP: ["好的，我来看看怎么做最优雅。你偏好哪种方式？", "这个改动比较大，你希望我先小范围试一下吗？"],
  ESTP: ["搞定。我直接上手了，有问题随时叫停。", "这个操作不可逆，需要你先确认。"],
  ESFP: ["交给我！我先快速做个原型给你看看效果？", "这个需要你拍板——涉及到重要的改动。"],
};

const MBTI_PREVIEW_EN: Record<FridayCommunicationMbti, [string, string]> = {
  INTJ: ["Analysis complete. Option A has the lowest risk — shall I proceed?", "This modifies production config. I'll execute immediately after your approval."],
  INTP: ["I've identified three possible root causes. Let me lay them out — which direction is worth exploring?", "This change may have cascading effects. Let me simulate first."],
  ENTJ: ["Clear objective. I've planned a 3-step execution path. Starting now?", "This requires approval. Once confirmed, I'll complete it in one pass."],
  ENTP: ["Here's a more interesting angle — what if we pull the data directly via API instead?", "This path has risks, but it's worth trying. Need your go-ahead."],
  INFJ: ["I understand what you're going for. I'll work at your pace, starting with the safest part.", "This step is sensitive — I'd like to confirm your thinking before I proceed."],
  INFP: ["That's a lovely idea. Let me help turn it into something actionable — where feels right to start?", "This has some risk — how would you like me to handle it?"],
  ENFJ: ["Great goal! I suggest we take three steps, and I'll check in with you at each one. Ready?", "This needs your approval. Don't worry, I'll explain what each step does."],
  ENFP: ["Love it! I can think of several ways to do this. Try the fastest one first?", "This is a bit risky, but the upside is huge. Your call!"],
  ISTJ: ["Understood. Following standard procedure: verify prerequisites, then execute step by step.", "This requires approval. Protocol requires confirmation before action."],
  ISFJ: ["Sure, I'll handle it carefully. Let me back up the current state first, then start making changes.", "This operation affects existing data — I'd like to check with you first."],
  ESTJ: ["Got it. Task broken down, ETA 3 minutes. Starting.", "This exceeds auto-execution scope. Need your approval."],
  ESFJ: ["I'll get this sorted for you. Handle the most urgent part first, then we can prioritize the rest together?", "This step needs your okay — I'll make sure it doesn't affect anyone else."],
  ISTP: ["Done. Which project?", "Risky. Need your confirmation."],
  ISFP: ["Okay, let me figure out the most elegant approach. Any preference?", "This is a big change — want me to try it on a small scale first?"],
  ESTP: ["On it. I'll start right away — holler if you want me to stop.", "This is irreversible. Need your confirmation first."],
  ESFP: ["Leave it to me! Let me whip up a quick prototype so you can see the result?", "This needs your sign-off — it's a significant change."],
};

export function buildPersonaPreview(settings: FridayCommunicationPersonaSettings, locale?: string, mbti?: FridayCommunicationMbti | "" | null): FridayCommunicationPersona["preview"] {
  const zh = locale === "zh";

  // If a specific MBTI is provided, use its unique preview
  if (mbti && mbti in MBTI_PREVIEW_ZH) {
    const [clarifier, boundary] = zh ? MBTI_PREVIEW_ZH[mbti] : MBTI_PREVIEW_EN[mbti];
    return {
      styleLabel: `${settings.tone}/${settings.verbosity}/${settings.directness}`,
      sampleClarifier: clarifier,
      sampleBoundary: boundary,
    };
  }

  // Fallback for no MBTI selected
  return {
    styleLabel: `${settings.tone}/${settings.verbosity}/${settings.directness}`,
    sampleClarifier: zh
      ? "我可以帮你处理这件事。你希望从哪个部分开始？"
      : "I can help with that. Which part would you like to start with?",
    sampleBoundary: zh
      ? "这是一个高风险步骤。我需要你的批准才能继续。"
      : "This is a high-risk step. I need your approval before I continue.",
  };
}

/** Short descriptions for each MBTI type, localized. */
export function getMbtiDescription(mbti: FridayCommunicationMbti, locale?: string): string {
  const zh = locale === "zh";
  const descriptions: Record<FridayCommunicationMbti, [string, string]> = {
    INTJ: ["策略型：精准、简洁、逻辑驱动", "Strategic: precise, concise, logic-driven"],
    INTP: ["分析型：深度探索、注重细节", "Analytical: deep exploration, detail-oriented"],
    ENTJ: ["指挥型：高效、结构化、目标导向", "Commander: efficient, structured, goal-oriented"],
    ENTP: ["辩论型：灵活、发散思维、快速迭代", "Debater: flexible, divergent thinking, fast iteration"],
    INFJ: ["顾问型：温和、有同理心、结构清晰", "Counselor: warm, empathetic, clearly structured"],
    INFP: ["理想型：温暖、细腻、注重感受", "Idealist: warm, sensitive, feeling-oriented"],
    ENFJ: ["教练型：鼓励、引导式、注重成长", "Coach: encouraging, guided, growth-focused"],
    ENFP: ["激励型：热情、发散、注重可能性", "Inspirer: enthusiastic, exploratory, possibility-focused"],
    ISTJ: ["执行型：务实、严谨、按规办事", "Inspector: practical, rigorous, by-the-book"],
    ISFJ: ["守护型：耐心、细致、关注他人", "Protector: patient, thorough, others-focused"],
    ESTJ: ["管理型：果断、高效、注重结果", "Director: decisive, efficient, results-focused"],
    ESFJ: ["协调型：友善、条理清晰、注重和谐", "Provider: friendly, organized, harmony-focused"],
    ISTP: ["工匠型：极简、直接、动手派", "Craftsman: minimal, direct, hands-on"],
    ISFP: ["艺术型：温和、灵活、审美驱动", "Artist: gentle, flexible, aesthetics-driven"],
    ESTP: ["冒险型：快速、务实、行动导向", "Adventurer: fast, pragmatic, action-oriented"],
    ESFP: ["表演型：活力、友好、注重体验", "Entertainer: energetic, friendly, experience-focused"],
  };
  const [zhDesc, enDesc] = descriptions[mbti];
  return zh ? zhDesc : enDesc;
}

export function buildPersonaDraft(persona?: FridayCommunicationPersona): {
  mbti: FridayCommunicationMbti | "";
  settings: FridayCommunicationPersonaSettings;
} {
  return {
    mbti: persona?.mbti ?? "",
    settings: { ...(persona?.settings ?? DEFAULT_COMMUNICATION_SETTINGS) },
  };
}
