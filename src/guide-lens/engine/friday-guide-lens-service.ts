import { FridayDomainError } from "#errors";
import type { FridaySystemService } from "../../system/engine/friday-system-service.js";
import type { FridaySystemCompanionBridge } from "../../system/companion/friday-system-companion.types.js";
import {
  FRIDAY_GUIDE_LENS_MUTATING_ACTIONS,
  type FridayGuideLensAvatarPreference,
  type FridayGuideLensElement,
  type FridayGuideLensEvent,
  type FridayGuideLensOverlayCommand,
  type FridayGuideLensParserAdapter,
  type FridayGuideLensParserResult,
  type FridayGuideLensPreferences,
  type FridayGuideLensScreenshotIntakeRequest,
  type FridayGuideLensService,
  type FridayGuideLensSession,
  type FridayGuideLensShowOverlayRequest,
  type FridayGuideLensSnapshotRequest,
  type FridayGuideLensState,
  type FridayGuideLensUiMap,
  type FridayGuideLensVerificationRequest,
} from "../model/friday-guide-lens.types.js";
import { buildFridayGuideLensUiMap } from "./ui-map-builder.js";
import { resolveFridayGuideLensTarget } from "./target-resolver.js";
import { analyzeFridayGuideLensScreenshot } from "./screenshot-intake.js";
import { verifyFridayGuideLensProgress } from "./verification.js";
import { minimizeGuideLensParserText } from "./redaction.js";

export interface CreateFridayGuideLensServiceDeps {
  idGenerator: () => string;
  nowIso: () => string;
  systemService?: Pick<FridaySystemService, "getState">;
  companionBridge?: Pick<
    FridaySystemCompanionBridge,
    "captureSnapshot" | "showGuideOverlay" | "clearGuideOverlay" | "setOverlayVisible"
  >;
  parserAdapter?: FridayGuideLensParserAdapter;
  defaultPreferences?: Partial<FridayGuideLensPreferences>;
  preferenceStore?: FridayGuideLensPreferenceStore;
}

export interface FridayGuideLensPreferenceStore {
  load(): Partial<FridayGuideLensPreferences> | undefined;
  save(preferences: FridayGuideLensPreferences): void;
}

const DEFAULT_AVATAR: FridayGuideLensAvatarPreference = {
  kind: "default_f",
  initials: "F",
  sizePx: 56,
};

const DEFAULT_PREFERENCES: FridayGuideLensPreferences = {
  enabled: true,
  triggerPolicy: "confirm_first",
  defaultSurface: "native_desktop",
  overlayStyle: "restrained_premium",
  focusColor: "blue",
  dimBackground: false,
  clickThroughOverlay: true,
  bubbleControlsEnabled: true,
  sensitiveScreenConfirm: true,
  localOnlyByDefault: true,
  screenshotAutoAnalyze: "manual_upload_only",
  chatboxPolicy: "ask_when_ambiguous",
  parserProvider: "local_none",
  avatar: DEFAULT_AVATAR,
};

function mergePreferences(
  base: FridayGuideLensPreferences,
  patch?: Partial<FridayGuideLensPreferences>,
): FridayGuideLensPreferences {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    dimBackground: false,
    clickThroughOverlay: true,
    focusColor: "blue",
    overlayStyle: "restrained_premium",
    avatar: {
      ...base.avatar,
      ...(patch.avatar ?? {}),
      sizePx: Math.max(40, Math.min(96, patch.avatar?.sizePx ?? base.avatar.sizePx)),
    },
  };
}

function assertSupportedPreferences(prefs: FridayGuideLensPreferences): void {
  if (prefs.dimBackground !== false) {
    throw new FridayDomainError("GUIDE_LENS_INVALID_PREFERENCES", "Guide Lens does not support dimming the whole screen", {
      httpStatus: 400,
    });
  }
  if (prefs.clickThroughOverlay !== true) {
    throw new FridayDomainError("GUIDE_LENS_INVALID_PREFERENCES", "Guide Lens overlay must remain click-through", {
      httpStatus: 400,
    });
  }
}

function hasMutatingAction(action: string): boolean {
  const normalized = action.trim().toLowerCase();
  return FRIDAY_GUIDE_LENS_MUTATING_ACTIONS.some((mutating) =>
    normalized === mutating || normalized.includes(mutating),
  );
}

function trimSessions(sessions: FridayGuideLensSession[]): FridayGuideLensSession[] {
  return sessions.slice(-20);
}

function redactOptionalText(
  text: string | undefined,
  source: "visible_text" | "screenshot_text" | "element_text",
): string | undefined {
  return text ? minimizeGuideLensParserText(text, source).text : text;
}

function sanitizeElementForParser(element: FridayGuideLensElement): FridayGuideLensElement {
  return {
    ...element,
    label: redactOptionalText(element.label, "element_text"),
    text: redactOptionalText(element.text, "element_text"),
    description: redactOptionalText(element.description, "element_text"),
    metadata: undefined,
  };
}

function sanitizeSnapshotForParser(req: FridayGuideLensSnapshotRequest): FridayGuideLensSnapshotRequest {
  return {
    sessionId: req.sessionId,
    surface: req.surface,
    objective: req.objective,
    visibleText: redactOptionalText(req.visibleText, "visible_text"),
    screenshotText: redactOptionalText(req.screenshotText, "screenshot_text"),
    screen: req.screen,
    elements: req.elements?.map(sanitizeElementForParser),
    parser: req.parser,
  };
}

function joinTextParts(...parts: Array<string | undefined>): string | undefined {
  const joined = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n");
  return joined.length > 0 ? joined : undefined;
}

export function createFridayGuideLensService(
  deps: CreateFridayGuideLensServiceDeps,
): FridayGuideLensService {
  let preferences = mergePreferences(
    mergePreferences(DEFAULT_PREFERENCES, deps.defaultPreferences),
    deps.preferenceStore?.load(),
  );
  assertSupportedPreferences(preferences);
  let activeSessionId: string | undefined;
  let sessions: FridayGuideLensSession[] = [];

  function emit(
    session: FridayGuideLensSession,
    event: FridayGuideLensEvent["event"],
    payload: Record<string, unknown>,
  ): void {
    session.events.push({
      id: deps.idGenerator(),
      sessionId: session.id,
      event,
      emittedAt: deps.nowIso(),
      payload,
    });
    session.updatedAt = deps.nowIso();
  }

  function createSession(input?: {
    sessionId?: string;
    surface?: FridayGuideLensSession["surface"];
    objective?: string;
  }): FridayGuideLensSession {
    const now = deps.nowIso();
    const session: FridayGuideLensSession = {
      id: input?.sessionId ?? deps.idGenerator(),
      status: "idle",
      surface: input?.surface ?? preferences.defaultSurface,
      objective: input?.objective,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    sessions = trimSessions([...sessions, session]);
    activeSessionId = session.id;
    emit(session, "guide_lens.session.started", {
      surface: session.surface,
      objective: session.objective,
    });
    return session;
  }

  function getSession(sessionId?: string, input?: {
    surface?: FridayGuideLensSession["surface"];
    objective?: string;
  }): FridayGuideLensSession {
    const id = sessionId ?? activeSessionId;
    const existing = id ? sessions.find((session) => session.id === id) : undefined;
    if (existing) {
      activeSessionId = existing.id;
      return existing;
    }
    return createSession({ sessionId, ...input });
  }

  function getActiveSession(): FridayGuideLensSession | undefined {
    return activeSessionId ? sessions.find((session) => session.id === activeSessionId) : undefined;
  }

  async function showNativeOverlay(command: FridayGuideLensOverlayCommand): Promise<void> {
    if (!deps.companionBridge) {
      return;
    }
    if (typeof deps.companionBridge.showGuideOverlay === "function") {
      await deps.companionBridge.showGuideOverlay(command);
      return;
    }
    await deps.companionBridge.setOverlayVisible(true);
  }

  async function clearNativeOverlay(): Promise<void> {
    if (!deps.companionBridge) {
      return;
    }
    if (typeof deps.companionBridge.clearGuideOverlay === "function") {
      await deps.companionBridge.clearGuideOverlay();
      return;
    }
    await deps.companionBridge.setOverlayVisible(false);
  }

  async function runOptionalParser(
    request: FridayGuideLensSnapshotRequest,
  ): Promise<{ request: FridayGuideLensSnapshotRequest; result?: FridayGuideLensParserResult }> {
    if (request.parser?.used) {
      return { request };
    }
    const provider = preferences.parserProvider;
    if (provider === "local_none") {
      return { request };
    }
    if (!deps.parserAdapter) {
      return {
        request: {
          ...request,
          parser: {
            ...request.parser,
            provider,
            used: false,
            fallbackReason: "No Guide Lens parser adapter is configured.",
          },
        },
      };
    }
    try {
      const result = await deps.parserAdapter.parse({
        provider,
        snapshot: sanitizeSnapshotForParser(request),
      });
      return {
        result,
        request: {
          ...request,
          visibleText: joinTextParts(request.visibleText, result.visibleText),
          screenshotText: joinTextParts(request.screenshotText, result.screenshotText),
          elements: [...(request.elements ?? []), ...(result.elements ?? [])],
          parser: {
            ...request.parser,
            provider: result.provider ?? provider,
            used: result.used !== false,
            latencyMs: result.latencyMs,
            fallbackReason: result.fallbackReason,
          },
        },
      };
    } catch (error) {
      return {
        request: {
          ...request,
          parser: {
            ...request.parser,
            provider,
            used: false,
            fallbackReason: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }

  return {
    getState(): FridayGuideLensState {
      return {
        preferences,
        activeSession: getActiveSession(),
        sessions: [...sessions],
      };
    },

    updatePreferences(patch) {
      const next = mergePreferences(preferences, patch);
      assertSupportedPreferences(next);
      deps.preferenceStore?.save(next);
      preferences = next;
      return preferences;
    },

    updateAvatar(avatar) {
      const next = mergePreferences(preferences, {
        avatar: {
          ...preferences.avatar,
          ...avatar,
          sizePx: avatar.sizePx ?? preferences.avatar.sizePx,
        },
      });
      assertSupportedPreferences(next);
      deps.preferenceStore?.save(next);
      preferences = next;
      return preferences.avatar;
    },

    async captureSnapshot(req?: FridayGuideLensSnapshotRequest) {
      const session = getSession(req?.sessionId, {
        surface: req?.surface,
        objective: req?.objective,
      });
      session.status = "looking";

      const companionSnapshot = !req?.systemSnapshot && deps.companionBridge
        ? await deps.companionBridge.captureSnapshot().catch(() => undefined)
        : undefined;
      const systemSnapshot = req?.systemSnapshot
        ?? (deps.systemService ? await deps.systemService.getState().catch(() => undefined) : undefined);
      const request: FridayGuideLensSnapshotRequest = {
        ...req,
        systemSnapshot,
        visibleText: [
          req?.visibleText,
          companionSnapshot?.windows.map((window) => window.title).join("\n"),
        ].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n"),
      };
      const parsed = await runOptionalParser(request);
      const uiMap: FridayGuideLensUiMap = buildFridayGuideLensUiMap({
        id: deps.idGenerator(),
        nowIso: deps.nowIso(),
        preferences,
        request: parsed.request,
      });
      session.uiMap = uiMap;
      session.surface = uiMap.surface;
      session.objective = req?.objective ?? session.objective;
      session.status = "guiding";
      emit(session, "guide_lens.snapshot.captured", {
        uiMapId: uiMap.id,
        surface: uiMap.surface,
        elementCount: uiMap.elements.length,
        tokenEstimate: uiMap.parserStats.tokenEstimate,
      });
      return { session, uiMap };
    },

    async resolveTarget(req) {
      this.assertReadOnlyAction(req.instruction);
      const session = getSession(req.sessionId);
      const uiMap = req.uiMap ?? session.uiMap ?? (await this.captureSnapshot({
        sessionId: session.id,
        objective: req.instruction,
      })).uiMap;
      const resolution = resolveFridayGuideLensTarget({
        idGenerator: deps.idGenerator,
        nowIso: deps.nowIso,
        sessionId: session.id,
        preferences,
        uiMap,
        request: req,
      });
      session.status = resolution.status === "not_found" ? "blocked" : "waiting_for_user";
      session.overlay = resolution.overlay;
      session.awaitingUser = resolution.requiredUserAction;
      emit(session, "guide_lens.target.resolved", {
        status: resolution.status,
        confidence: resolution.confidence,
        targetElementId: resolution.target?.id,
        alternatives: resolution.alternatives.length,
      });
      await showNativeOverlay(resolution.overlay);
      emit(session, "guide_lens.overlay.shown", {
        overlayId: resolution.overlay.id,
        mode: resolution.overlay.mode,
      });
      return resolution;
    },

    async showOverlay(req: FridayGuideLensShowOverlayRequest) {
      this.assertReadOnlyAction(req.message);
      const session = getSession(req.sessionId, {
        surface: req.surface,
      });
      const now = deps.nowIso();
      const command: FridayGuideLensOverlayCommand = {
        id: deps.idGenerator(),
        sessionId: session.id,
        mode: req.mode ?? "speech_bubble",
        surface: req.surface ?? session.surface,
        message: req.message,
        targetElementId: req.targetElementId,
        targetBounds: req.targetBounds,
        candidates: req.candidates,
        step: req.step,
        avatar: preferences.avatar,
        tone: req.tone ?? "calm",
        focusColor: "blue",
        dimBackground: false,
        clickThrough: true,
        bubbleControlsEnabled: preferences.bubbleControlsEnabled,
        createdAt: now,
        expiresAt: req.expiresInMs ? new Date(new Date(now).getTime() + req.expiresInMs).toISOString() : undefined,
      };
      session.status = command.mode === "blocked" ? "blocked" : "waiting_for_user";
      session.overlay = command;
      await showNativeOverlay(command);
      emit(session, "guide_lens.overlay.shown", {
        overlayId: command.id,
        mode: command.mode,
      });
      return command;
    },

    async clearOverlay(sessionId?: string) {
      const session = getSession(sessionId);
      session.overlay = undefined;
      session.awaitingUser = undefined;
      session.status = "idle";
      await clearNativeOverlay();
      const clearedAt = deps.nowIso();
      emit(session, "guide_lens.overlay.cleared", { clearedAt });
      return {
        cleared: true,
        sessionId: session.id,
        clearedAt,
      };
    },

    async analyzeScreenshot(req: FridayGuideLensScreenshotIntakeRequest) {
      const session = getSession(req.sessionId, {
        surface: "screenshot",
        objective: req.question,
      });
      const result = analyzeFridayGuideLensScreenshot({
        ...req,
        sessionId: session.id,
      });
      session.status = result.needsChatbox ? "blocked" : "guiding";
      emit(session, "guide_lens.screenshot.analyzed", {
        intent: result.intent,
        needsChatbox: result.needsChatbox,
        confidence: result.confidence,
        redactions: result.redactions.length,
      });
      if (result.needsChatbox) {
        await this.showOverlay({
          sessionId: session.id,
          mode: "speech_bubble",
          message: result.chatboxPrompt ?? "请补充你想完成哪一步。",
          tone: "blocked",
          surface: "screenshot",
        });
      }
      return result;
    },

    async verify(req: FridayGuideLensVerificationRequest) {
      const session = getSession(req.sessionId);
      const uiMap = req.uiMap ?? session.uiMap ?? (await this.captureSnapshot({
        sessionId: session.id,
      })).uiMap;
      session.status = "checking";
      const result = verifyFridayGuideLensProgress({
        nowIso: deps.nowIso,
        uiMap,
        request: req,
      });
      session.lastVerification = result;
      session.status = result.status === "passed"
        ? "completed"
        : result.status === "failed"
          ? "waiting_for_user"
          : "blocked";
      emit(session, "guide_lens.verification.completed", {
        status: result.status,
        confidence: result.confidence,
      });
      return result;
    },

    assertReadOnlyAction(action: string): void {
      if (hasMutatingAction(action)) {
        throw new FridayDomainError(
          "GUIDE_LENS_READ_ONLY_VIOLATION",
          "Guide Lens can only observe and guide. Real clicks, typing, scrolling, app launches, approvals, and writes must be performed by the user or another explicitly authorized mode.",
          { httpStatus: 403, details: { action } },
        );
      }
    },
  };
}
