import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type {
  FridayGuideLensBounds,
  FridayGuideLensOverlayMode,
  FridayGuideLensService,
  FridayGuideLensSurface,
} from "../../guide-lens/model/friday-guide-lens.types.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

export interface CreateFridayAgentGuideLensToolOptions {
  guideLensService: FridayGuideLensService;
}

type GuideLensAction =
  | "state"
  | "snapshot"
  | "resolve_target"
  | "show_overlay"
  | "clear_overlay"
  | "screenshot_intake"
  | "verify"
  | "update_preferences"
  | "update_avatar";

const VALID_ACTIONS = new Set<GuideLensAction>([
  "state",
  "snapshot",
  "resolve_target",
  "show_overlay",
  "clear_overlay",
  "screenshot_intake",
  "verify",
  "update_preferences",
  "update_avatar",
]);

function readObjectParam<T extends Record<string, unknown>>(
  args: Record<string, unknown>,
  key: string,
): T | undefined {
  const value = args[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as T;
  }
  return undefined;
}

function readBoundsParam(
  args: Record<string, unknown>,
  key: string,
): FridayGuideLensBounds | undefined {
  const value = readObjectParam(args, key);
  if (!value) return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { x, y, width, height };
}

export function createFridayAgentGuideLensTool(
  options: CreateFridayAgentGuideLensToolOptions,
): FridayAgentToolDefinition {
  const { guideLensService } = options;

  return {
    name: "guide_lens",
    description:
      "Read-only Guide Mode for seeing the user's visible UI and drawing a non-clicking native overlay. " +
      "Use it to capture a compact UI map, resolve a target, show a blue focus frame or speech bubble, analyze screenshots, and verify progress. " +
      "It must never click, type, scroll, launch apps, write files, approve permissions, or mutate the desktop.",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: Array.from(VALID_ACTIONS),
          description: "Guide Lens action.",
        },
        sessionId: { type: "string" },
        surface: {
          type: "string",
          enum: ["native_desktop", "browser", "friday_web", "remote_session", "screenshot"],
        },
        objective: { type: "string" },
        instruction: { type: "string", description: "Target to locate, such as the visible button or field name." },
        message: { type: "string", description: "Short user-facing overlay instruction." },
        visibleText: { type: "string", description: "Optional local visible text snapshot." },
        screenshotText: { type: "string", description: "Optional OCR/screenshot text; secrets are redacted by the service." },
        question: { type: "string", description: "User question attached to a screenshot." },
        mode: {
          type: "string",
          enum: [
            "avatar_bubble",
            "focus_frame",
            "cursor_ghost",
            "speech_bubble",
            "scroll_hint",
            "page_transition",
            "numbered_marks",
            "candidate_picker",
            "confirm_step",
            "blocked",
            "clear",
          ],
        },
        targetBounds: { type: "object", description: "Optional {x,y,width,height} in screen coordinates." },
        expected: { type: "object", description: "Verification criteria." },
        preferences: { type: "object", description: "Guide Lens preference patch." },
        avatar: { type: "object", description: "Avatar patch: default_f, profile_image, or local_image." },
        maxCandidates: { type: "number" },
      },
      required: ["action"],
    },

    async execute(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as GuideLensAction;
      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        for (const key of ["actionType", "intent", "instruction", "message"]) {
          const value = args[key];
          if (typeof value === "string") {
            guideLensService.assertReadOnlyAction(value);
          }
        }

        const sessionId = readStringParam(args, "sessionId");
        if (action === "state") {
          return jsonResult(guideLensService.getState());
        }
        if (action === "snapshot") {
          return jsonResult(await guideLensService.captureSnapshot({
            sessionId,
            surface: readStringParam(args, "surface") as FridayGuideLensSurface | undefined,
            objective: readStringParam(args, "objective"),
            visibleText: readStringParam(args, "visibleText"),
            screenshotText: readStringParam(args, "screenshotText"),
          }));
        }
        if (action === "resolve_target") {
          const instruction = readStringParam(args, "instruction", { required: true });
          return jsonResult(await guideLensService.resolveTarget({
            sessionId,
            instruction,
            maxCandidates: readNumberParam(args, "maxCandidates", { integer: true }),
          }));
        }
        if (action === "show_overlay") {
          const message = readStringParam(args, "message", { required: true });
          return jsonResult(await guideLensService.showOverlay({
            sessionId,
            surface: readStringParam(args, "surface") as FridayGuideLensSurface | undefined,
            mode: readStringParam(args, "mode") as FridayGuideLensOverlayMode | undefined,
            message,
            targetBounds: readBoundsParam(args, "targetBounds"),
          }));
        }
        if (action === "clear_overlay") {
          return jsonResult(await guideLensService.clearOverlay(sessionId));
        }
        if (action === "screenshot_intake") {
          return jsonResult(await guideLensService.analyzeScreenshot({
            sessionId,
            question: readStringParam(args, "question"),
            visibleText: readStringParam(args, "visibleText"),
            screenshotText: readStringParam(args, "screenshotText"),
            source: "upload",
          }));
        }
        if (action === "verify") {
          return jsonResult(await guideLensService.verify({
            sessionId,
            expected: readObjectParam(args, "expected"),
          }));
        }
        if (action === "update_preferences") {
          return jsonResult(guideLensService.updatePreferences(readObjectParam(args, "preferences") ?? {}));
        }
        return jsonResult(guideLensService.updateAvatar(readObjectParam(args, "avatar") ?? {}));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
