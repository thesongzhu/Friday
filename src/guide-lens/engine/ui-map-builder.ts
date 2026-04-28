import type {
  FridayGuideLensBounds,
  FridayGuideLensElement,
  FridayGuideLensPreferences,
  FridayGuideLensSnapshotRequest,
  FridayGuideLensUiMap,
} from "../model/friday-guide-lens.types.js";
import { redactGuideLensText } from "./redaction.js";

const DEFAULT_SCREEN = { width: 1440, height: 900 };

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function normalizeBounds(bounds: FridayGuideLensBounds | undefined): FridayGuideLensBounds | undefined {
  if (!bounds) return undefined;
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

function normalizeElement(
  element: FridayGuideLensElement,
  index: number,
): FridayGuideLensElement {
  const label = element.label?.trim();
  const text = element.text?.trim();
  return {
    ...element,
    id: element.id?.trim() || `manual:${String(index + 1)}`,
    role: element.role?.trim() || "unknown",
    ...(label ? { label } : {}),
    ...(text ? { text } : {}),
    bounds: normalizeBounds(element.bounds),
    confidence: clampConfidence(element.confidence),
    interactable: Boolean(element.interactable),
    sensitive: Boolean(element.sensitive),
  };
}

function lineRole(line: string): string {
  const normalized = line.trim().toLowerCase();
  if (/^(sign in|log in|continue|next|done|save|submit|allow|cancel|ok|open|connect|authorize)$/i.test(line.trim())) {
    return "button";
  }
  if (/(email|password|api key|token|code)/i.test(line)) {
    return "field";
  }
  if (/^https?:\/\//i.test(normalized)) {
    return "link";
  }
  return "text";
}

function synthesizeTextElements(input: {
  text: string;
  source: "ocr" | "manual";
  screen: { width: number; height: number };
  existingCount: number;
}): FridayGuideLensElement[] {
  const lines = input.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 80);
  const width = Math.min(Math.max(260, input.screen.width * 0.34), 720);
  const startX = Math.round(input.screen.width * 0.08);
  const startY = Math.round(input.screen.height * 0.12);
  const rowHeight = 32;
  return lines.map((line, index) => {
    const role = lineRole(line);
    return {
      id: `${input.source}:line:${String(input.existingCount + index + 1)}`,
      role,
      label: role === "button" || role === "field" || role === "link" ? line : undefined,
      text: line,
      bounds: {
        x: startX,
        y: startY + index * rowHeight,
        width,
        height: role === "text" ? 24 : 30,
      },
      source: input.source === "ocr" ? "ocr" : "manual",
      confidence: input.source === "ocr" ? 0.62 : 0.7,
      interactable: role === "button" || role === "field" || role === "link",
      sensitive: /(password|api key|secret|token|verification code)/i.test(line),
    } satisfies FridayGuideLensElement;
  });
}

function elementsFromSystemSnapshot(req: FridayGuideLensSnapshotRequest): FridayGuideLensElement[] {
  const snapshot = req.systemSnapshot;
  if (!snapshot) return [];
  const appsById = new Map(snapshot.apps.map((app) => [app.id, app]));
  return snapshot.windows.map((window, index) => {
    const app = appsById.get(window.appId);
    return {
      id: `system-window:${window.id}`,
      role: "window",
      label: window.title,
      text: `${app?.name ?? "App"} ${window.title}`,
      bounds: normalizeBounds(window.bounds),
      source: "system_window",
      confidence: window.focused ? 0.84 : 0.72,
      interactable: false,
      focused: window.focused,
      appId: window.appId,
      windowId: window.id,
      metadata: {
        appName: app?.name,
        bundleId: app?.bundleId,
        order: index,
      },
    } satisfies FridayGuideLensElement;
  });
}

function estimateTokenCount(text: string, elementCount: number): number {
  const textTokens = Math.ceil(text.length / 4);
  return Math.max(1, textTokens + elementCount * 18);
}

export function buildFridayGuideLensUiMap(input: {
  id: string;
  nowIso: string;
  preferences: FridayGuideLensPreferences;
  request?: FridayGuideLensSnapshotRequest;
}): FridayGuideLensUiMap {
  const req = input.request ?? {};
  const screen = req.screen ?? DEFAULT_SCREEN;
  const visible = redactGuideLensText(req.visibleText ?? "", "visible_text");
  const screenshot = redactGuideLensText(req.screenshotText ?? "", "screenshot_text");
  const visibleText = [visible.text, screenshot.text]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n");

  const providedElements = (req.elements ?? []).map((element, index) => {
    const textParts = [element.label, element.text, element.description]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join(" ");
    const redacted = redactGuideLensText(textParts, "element_text");
    const normalized = normalizeElement({
      ...element,
      label: element.label ? redactGuideLensText(element.label, "element_text").text : element.label,
      text: element.text ? redactGuideLensText(element.text, "element_text").text : element.text,
      description: element.description
        ? redactGuideLensText(element.description, "element_text").text
        : element.description,
      sensitive: element.sensitive || redacted.redactions.length > 0,
    }, index);
    return normalized;
  });
  const systemElements = elementsFromSystemSnapshot(req);
  const textElements = synthesizeTextElements({
    text: visibleText,
    source: req.screenshotText ? "ocr" : "manual",
    screen,
    existingCount: providedElements.length + systemElements.length,
  });
  const elements = [...providedElements, ...systemElements, ...textElements]
    .slice(0, 180)
    .map((element, index) => normalizeElement(element, index));

  const frontmostWindow = req.systemSnapshot?.windows.find((window) => window.id === req.systemSnapshot?.frontmostWindowId)
    ?? req.systemSnapshot?.windows.find((window) => window.focused);
  const frontmostApp = req.systemSnapshot?.apps.find((app) => app.id === req.systemSnapshot?.frontmostAppId)
    ?? req.systemSnapshot?.apps.find((app) => app.frontmost);

  return {
    id: input.id,
    capturedAt: input.nowIso,
    surface: req.surface ?? input.preferences.defaultSurface,
    objective: req.objective,
    screen,
    app: frontmostApp
      ? {
        id: frontmostApp.id,
        name: frontmostApp.name,
        bundleId: frontmostApp.bundleId,
      }
      : undefined,
    window: frontmostWindow
      ? {
        id: frontmostWindow.id,
        title: frontmostWindow.title,
        bounds: normalizeBounds(frontmostWindow.bounds),
      }
      : undefined,
    visibleText,
    elements,
    redactions: [...visible.redactions, ...screenshot.redactions],
    parserStats: {
      provider: req.parser?.provider ?? input.preferences.parserProvider,
      used: Boolean(req.parser?.used),
      latencyMs: req.parser?.latencyMs,
      tokenEstimate: estimateTokenCount(visibleText, elements.length),
      fallbackReason: req.parser?.fallbackReason,
    },
    systemSnapshot: req.systemSnapshot
      ? {
        capturedAt: req.systemSnapshot.capturedAt,
        platform: req.systemSnapshot.platform,
        frontmostAppId: req.systemSnapshot.frontmostAppId,
        frontmostWindowId: req.systemSnapshot.frontmostWindowId,
      }
      : undefined,
  };
}
