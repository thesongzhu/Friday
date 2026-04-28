import { describe, expect, it, vi } from "vitest";

import { createFridayAgentGuideLensTool } from "../../../../src/agent/tools/friday-agent-guide-lens-tool.js";
import type { FridayGuideLensService } from "../../../../src/guide-lens/model/friday-guide-lens.types.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function service(): FridayGuideLensService {
  return {
    getState: vi.fn().mockReturnValue({ preferences: {}, sessions: [] }),
    updatePreferences: vi.fn().mockReturnValue({ enabled: true }),
    updateAvatar: vi.fn().mockReturnValue({ kind: "default_f", initials: "F", sizePx: 56 }),
    captureSnapshot: vi.fn().mockResolvedValue({ session: { id: "s-1" }, uiMap: { id: "map-1" } }),
    resolveTarget: vi.fn().mockResolvedValue({ status: "resolved" }),
    showOverlay: vi.fn().mockResolvedValue({ id: "overlay-1" }),
    clearOverlay: vi.fn().mockResolvedValue({ cleared: true }),
    analyzeScreenshot: vi.fn().mockResolvedValue({ intent: "permission" }),
    verify: vi.fn().mockResolvedValue({ status: "passed" }),
    assertReadOnlyAction: vi.fn((value: string) => {
      if (/click|type|scroll/i.test(value)) {
        throw new Error("Guide Lens read-only violation");
      }
    }),
  } as unknown as FridayGuideLensService;
}

describe("createFridayAgentGuideLensTool", () => {
  it("captures screenshots through the read-only guide lens service", async () => {
    const guideLensService = service();
    const tool = createFridayAgentGuideLensTool({ guideLensService });

    const result = await tool.execute({
      action: "screenshot_intake",
      screenshotText: "Screen Recording permission required",
    }, signal());

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ intent: "permission" });
    expect(guideLensService.analyzeScreenshot).toHaveBeenCalledWith(expect.objectContaining({
      screenshotText: "Screen Recording permission required",
      source: "upload",
    }));
  });

  it("rejects mutating instructions", async () => {
    const guideLensService = service();
    const tool = createFridayAgentGuideLensTool({ guideLensService });

    const result = await tool.execute({
      action: "resolve_target",
      instruction: "click Save",
    }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only violation");
    expect(guideLensService.resolveTarget).not.toHaveBeenCalled();
  });

  it("updates avatar preferences", async () => {
    const guideLensService = service();
    const tool = createFridayAgentGuideLensTool({ guideLensService });

    const result = await tool.execute({
      action: "update_avatar",
      avatar: { kind: "local_image", localPath: "/tmp/me.png" },
    }, signal());

    expect(result.isError).toBeUndefined();
    expect(guideLensService.updateAvatar).toHaveBeenCalledWith({
      kind: "local_image",
      localPath: "/tmp/me.png",
    });
  });
});
