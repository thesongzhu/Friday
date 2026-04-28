import type {
  FridayGuideLensElement,
  FridayGuideLensOverlayCommand,
  FridayGuideLensPreferences,
  FridayGuideLensResolveTargetRequest,
  FridayGuideLensTargetResolution,
  FridayGuideLensUiMap,
} from "../model/friday-guide-lens.types.js";

const ROLE_BONUS: Record<string, number> = {
  button: 0.18,
  link: 0.16,
  field: 0.12,
  checkbox: 0.12,
  menuitem: 0.1,
  tab: 0.1,
  window: 0.03,
};

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "on",
  "in",
  "at",
  "of",
  "for",
  "and",
  "or",
  "this",
  "that",
  "button",
  "click",
  "tap",
  "press",
  "open",
  "选择",
  "点击",
  "按钮",
  "打开",
  "这个",
  "那个",
  "下一步",
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function elementText(element: FridayGuideLensElement): string {
  return [element.label, element.text, element.description, element.role]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
}

function scoreElement(instruction: string, element: FridayGuideLensElement): number {
  const normalizedInstruction = normalize(instruction);
  const normalizedText = normalize(elementText(element));
  if (!normalizedText) {
    return 0;
  }

  let score = 0;
  if (normalizedText === normalizedInstruction) {
    score += 0.58;
  } else if (normalizedText.includes(normalizedInstruction) || normalizedInstruction.includes(normalizedText)) {
    score += 0.38;
  }

  const instructionTokens = tokens(instruction);
  const elementTokens = new Set(tokens(normalizedText));
  const hits = instructionTokens.filter((token) => elementTokens.has(token)).length;
  if (instructionTokens.length > 0) {
    score += hits / instructionTokens.length * 0.32;
  }

  score += ROLE_BONUS[element.role.toLowerCase()] ?? 0;
  if (element.interactable) score += 0.08;
  if (element.focused) score += 0.04;
  if (element.enabled === false) score -= 0.18;
  if (element.sensitive) score -= 0.06;
  score += element.confidence * 0.18;

  return Math.max(0, Math.min(1, score));
}

function buildOverlay(input: {
  id: string;
  sessionId: string;
  uiMap: FridayGuideLensUiMap;
  preferences: FridayGuideLensPreferences;
  instruction: string;
  mode: FridayGuideLensOverlayCommand["mode"];
  message: string;
  target?: FridayGuideLensElement;
  alternatives: FridayGuideLensElement[];
  createdAt: string;
}): FridayGuideLensOverlayCommand {
  return {
    id: input.id,
    sessionId: input.sessionId,
    mode: input.mode,
    surface: input.uiMap.surface,
    message: input.message,
    targetElementId: input.target?.id,
    targetBounds: input.target?.bounds,
    candidates: input.alternatives.slice(0, 5).map((element) => ({
      elementId: element.id,
      label: element.label ?? element.text ?? element.role,
      bounds: element.bounds,
      confidence: element.confidence,
    })),
    avatar: input.preferences.avatar,
    tone: input.mode === "blocked" ? "blocked" : "calm",
    focusColor: "blue",
    dimBackground: false,
    clickThrough: true,
    bubbleControlsEnabled: input.preferences.bubbleControlsEnabled,
    createdAt: input.createdAt,
    metadata: {
      instruction: input.instruction,
      tokenEstimate: input.uiMap.parserStats.tokenEstimate,
    },
  };
}

export function resolveFridayGuideLensTarget(input: {
  idGenerator: () => string;
  nowIso: () => string;
  sessionId: string;
  preferences: FridayGuideLensPreferences;
  uiMap: FridayGuideLensUiMap;
  request: FridayGuideLensResolveTargetRequest;
}): FridayGuideLensTargetResolution {
  const maxCandidates = input.request.maxCandidates ?? 5;
  const ranked = input.uiMap.elements
    .map((element) => ({
      element,
      score: scoreElement(input.request.instruction, element),
    }))
    .filter((entry) => entry.score > 0.08)
    .sort((left, right) => right.score - left.score);
  const alternatives = ranked
    .slice(0, maxCandidates)
    .map((entry) => ({
      ...entry.element,
      confidence: Math.max(entry.element.confidence, entry.score),
    }));
  const top = ranked[0];
  const second = ranked[1];
  const confidence = top?.score ?? 0;
  const ambiguous = Boolean(top && second && Math.abs(top.score - second.score) < 0.08);

  if (!top || confidence < 0.42) {
    const overlay = buildOverlay({
      id: input.idGenerator(),
      sessionId: input.sessionId,
      uiMap: input.uiMap,
      preferences: input.preferences,
      instruction: input.request.instruction,
      mode: "blocked",
      message: "我还没有足够把握定位到目标。请告诉我按钮或文字的名字，或发一张更完整的截图。",
      alternatives,
      createdAt: input.nowIso(),
    });
    return {
      status: "not_found",
      instruction: input.request.instruction,
      alternatives,
      confidence,
      reason: "No visible element matched the instruction with enough confidence.",
      overlay,
      requiredUserAction: {
        action: "clarify",
        reason: "target_not_found",
      },
    };
  }

  if (ambiguous) {
    const overlay = buildOverlay({
      id: input.idGenerator(),
      sessionId: input.sessionId,
      uiMap: input.uiMap,
      preferences: input.preferences,
      instruction: input.request.instruction,
      mode: "candidate_picker",
      message: "我看到了几个可能的位置。请确认蓝色编号里你要操作的是哪一个。",
      target: top.element,
      alternatives,
      createdAt: input.nowIso(),
    });
    return {
      status: "ambiguous",
      instruction: input.request.instruction,
      target: top.element,
      alternatives,
      confidence,
      reason: "Multiple visible elements are similarly likely.",
      overlay,
      requiredUserAction: {
        action: "clarify",
        reason: "ambiguous_target",
        targetElementId: top.element.id,
      },
    };
  }

  const target = {
    ...top.element,
    confidence: Math.max(top.element.confidence, confidence),
  };
  const overlay = buildOverlay({
    id: input.idGenerator(),
    sessionId: input.sessionId,
    uiMap: input.uiMap,
    preferences: input.preferences,
    instruction: input.request.instruction,
    mode: target.bounds ? "focus_frame" : "speech_bubble",
    message: target.bounds
      ? "请点击蓝色框标出的这个位置。完成后我会再看一眼确认是否进入下一步。"
      : "请在当前页面找到这个项目并操作；我没有拿到可靠坐标，所以先用文字引导。",
    target,
    alternatives,
    createdAt: input.nowIso(),
  });

  return {
    status: "resolved",
    instruction: input.request.instruction,
    target,
    alternatives,
    confidence,
    reason: "A visible target matched the instruction.",
    overlay,
    requiredUserAction: {
      action: target.role === "field" ? "type" : "click",
      reason: "guide_mode_never_mutates_desktop",
      targetElementId: target.id,
    },
  };
}
