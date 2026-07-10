import { describe, expect, it } from "vitest";
import { listFridayProviderTemplates } from "#providers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { AVAILABLE_COMMANDS } from "../../../ui/src/components/core/command-palette";
import { CHANNEL_KINDS_ORDERED, CHANNEL_META } from "../../../ui/src/lib/channels/channel-meta";
import {
  SETUP_CHANNEL_KINDS_ORDERED,
  buildSetupCompletionStepState,
  buildSetupCompletionTitle,
  getProviderBootstrapRecommendation,
  getSetupProviderKindsForRegion,
} from "../../../ui/src/routes/setup-page";
import { buildFridayReadinessSummary } from "../../../ui/src/components/setup/friday-readiness-summary";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const readRepoFile = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

describe("ui truth regressions", () => {
  it("keeps activity timeline dot colors on selected Friday tokens without Tailwind fallbacks", () => {
    const source = readRepoFile("ui/src/components/core/activity-timeline.tsx");

    expect(source).not.toContain("#34d399");
    expect(source).not.toContain("#fbbf24");
    expect(source).not.toContain("#60a5fa");
    expect(source).not.toContain("#9ca3af");

    expect(source).toContain("bg-[color:var(--color-text-success)]");
    expect(source).toContain("bg-[color:var(--color-text-warning)]");
    expect(source).toContain("bg-[color:var(--color-accent)]");
    expect(source).toContain("bg-[color:var(--color-text-tertiary)]");
  });

  it("keeps operator console discoverable in the command palette", () => {
    expect(AVAILABLE_COMMANDS.some((item) => item.path === "/command-center")).toBe(true);
  });

  it("keeps Google setup copy on the HTTP path instead of promising Gemini CLI", () => {
    const recommendation = getProviderBootstrapRecommendation("google");

    expect(recommendation.backend).toBe("HTTP only");
    expect(recommendation.boundary).not.toContain("Gemini CLI");
    expect(recommendation.operatorNote).not.toContain("Gemini CLI");
  });

  it("only shows setup provider choices that have a first-run closed-loop path", () => {
    const templates = listFridayProviderTemplates();

    expect(getSetupProviderKindsForRegion(templates, "international")).toEqual([
      "openai",
      "openai-codex",
      "anthropic",
      "openrouter",
      "xai",
      "mistral",
      "groq",
    ]);
    expect(getSetupProviderKindsForRegion(templates, "china")).toEqual([
      "deepseek",
      "moonshot",
      "qwen",
      "kimi-coding",
    ]);
  });

  it("keeps setup channels limited to verified first-run control routes", () => {
    expect(SETUP_CHANNEL_KINDS_ORDERED).toEqual(["telegram", "discord", "feishu"]);
  });

  it("does not claim Friday is ready when the AI provider step was skipped", () => {
    const skipped = buildSetupCompletionTitle("en", false);
    // Truthful: runtime-ready, not provider-ready.
    expect(skipped.title).toBe("Setup saved");
    expect(skipped.title).not.toBe("Friday is Ready");
    expect(skipped.subtitle).toMatch(/Connect an AI provider/i);

    const ready = buildSetupCompletionTitle("en", true);
    expect(ready.title).toBe("Friday is Ready");
    expect(ready.subtitle).toBeNull();
  });

  it("buckets an unverified AI text capability as needing connection, not ready", () => {
    const summary = buildFridayReadinessSummary(
      {
        capabilities: {
          runtime: {
            items: [
              { capability: "text", label: "Text model", state: "needs_user_auth", sources: [], blockers: [] },
            ],
          },
        },
      } as never,
      "en",
    );
    const readyBucket = summary.buckets.find((b) => b.id === "ready");
    const connectBucket = summary.buckets.find((b) => b.id === "connect");
    // The skipped/unverified text model must NOT appear as ready.
    expect(readyBucket?.items ?? []).not.toContain("Text model");
    expect(connectBucket?.items ?? []).toContain("Text model");
    // And the subline reflects an outstanding gap rather than "all ready".
    expect(summary.subline).toMatch(/need/i);
  });

  it("does not present unsupported QQ as an available shared channel", () => {
    expect(CHANNEL_META.qq.availability).toBe("unsupported");
    expect(CHANNEL_META.qq.description).toContain("Unsupported");
    expect(CHANNEL_META.qq.capabilities.directMessages).toBe(false);
    expect(CHANNEL_KINDS_ORDERED).not.toContain("qq");
  });

  it("labels Slack setup as socket-mode only instead of HTTP Events API", () => {
    expect(CHANNEL_META.slack.description).toContain("Socket Mode");
    expect(CHANNEL_META.slack.description).toContain("HTTP Events API inbound is unsupported");
    const channelConfigForm = readRepoFile("ui/src/components/core/channel-config-form.tsx");
    expect(channelConfigForm).toContain('label: "Slack Socket Mode"');
    expect(channelConfigForm).toContain('mode: "socket"');
  });

  it("surfaces memory cognition fields without claiming full autonomous recall", () => {
    const memoryApi = readRepoFile("ui/src/lib/api/memory.ts");
    const memoryPage = readRepoFile("ui/src/routes/memory-page.tsx");
    expect(memoryApi).toContain("memoryType?: FridayMemoryType | FridayMemoryType[]");
    expect(memoryApi).toContain("boostByConfidence?: boolean");
    expect(memoryApi).toContain("confidence?: number");
    expect(memoryPage).toContain("Confidence boost");
    expect(memoryPage).toContain("lastAccessedAt");
    expect(memoryPage).toContain("automatic recall still follows permission, ranking, and context boundaries");
    expect(memoryPage).not.toContain("Friday will learn as you interact.");
    expect(memoryPage).not.toContain("会在你使用过程中自动学习");
    expect(memoryPage).toContain("review or enabled learning flows save them");
  });

  it("keeps homepage repair copy inside the supervised proof boundary", () => {
    const homePage = readRepoFile("ui/src/routes/home-page.tsx");
    expect(homePage).toContain("Supervised repair");
    expect(homePage).toContain("full autonomous incident repair still needs separate proof");
  });

  it("records only promoted skills as completed setup work", () => {
    expect(buildSetupCompletionStepState({
      providerValidated: true,
      channelsSaved: true,
      skillsPromoted: true,
    })).toEqual({
      completedSteps: ["welcome", "security", "provider", "channels", "skills", "done"],
      skippedSteps: ["communication", "network"],
    });

    expect(buildSetupCompletionStepState({
      providerValidated: false,
      channelsSaved: false,
      skillsPromoted: false,
    })).toEqual({
      completedSteps: ["welcome", "security", "done"],
      skippedSteps: ["communication", "provider", "channels", "network", "skills"],
    });
  });
});
