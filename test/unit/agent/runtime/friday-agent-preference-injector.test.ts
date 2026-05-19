import { describe, expect, it, vi } from "vitest";

import type { FridayMemoryItem } from "../../../../src/memory/model/friday-memory.types.js";
import { createFridayPreferenceInjector } from "../../../../src/agent/runtime/friday-agent-preference-injector.js";

const NOW = "2026-05-11T00:00:00.000Z";
const USER_ID = "user-1";

function buildMemoryItem(overrides: Partial<FridayMemoryItem>): FridayMemoryItem {
  return {
    id: "mem-1",
    namespace: "learning.preferences",
    key: "language",
    content: "Prefer TypeScript with strict mode",
    source: "learning:user-1:event-1",
    tags: ["learning", "auto", "preference", USER_ID],
    metadata: { confidence: 0.7 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildMockMemoryService(items: FridayMemoryItem[]) {
  return {
    store: vi.fn(),
    search: vi.fn(),
    get: vi.fn(),
    list: vi.fn(async () => items),
    delete: vi.fn(),
    prune: vi.fn(),
  };
}

describe("createFridayPreferenceInjector — high-impact gate", () => {
  // ── Source 1: learningContextBuilder ───────────────────────────────────

  it("Source 1: injects benign learned facts at the default learning confidence", async () => {
    const injector = createFridayPreferenceInjector({
      memoryService: buildMockMemoryService([]) as any,
      learningContextBuilder: () => ({
        preferences: {
          language: "TypeScript",
          framework: "React",
        },
      }),
      nowIso: () => NOW,
    });

    const result = await injector.loadPreferences(USER_ID);

    expect(result.itemCount).toBe(2);
    expect(result.fragment).toContain("language: TypeScript");
    expect(result.fragment).toContain("framework: React");
    expect(result.sources).toContain("learning");
  });

  it("Source 1: skips high-impact learned facts (Reflex 17-key set) at any confidence", async () => {
    const injector = createFridayPreferenceInjector({
      memoryService: buildMockMemoryService([]) as any,
      learningContextBuilder: () => ({
        preferences: {
          // Both high-impact keys from the Reflex confirmation-required set:
          "automation.conservatism": "aggressive",
          "safety.high_risk_change_policy": "auto_apply_low_risk",
          "constitution.skeptical_mode": "enabled",
          // Benign key alongside high-impact ones:
          language: "TypeScript",
        },
      }),
      nowIso: () => NOW,
    });

    const result = await injector.loadPreferences(USER_ID);

    expect(result.itemCount).toBe(1);
    expect(result.fragment).toContain("language: TypeScript");
    expect(result.fragment).not.toContain("automation.conservatism");
    expect(result.fragment).not.toContain("safety.high_risk_change_policy");
    expect(result.fragment).not.toContain("constitution.skeptical_mode");
    expect(result.fragment).not.toContain("aggressive");
    expect(result.fragment).not.toContain("auto_apply_low_risk");
  });

  it("Source 1: returns no fragment when only high-impact keys are present", async () => {
    const injector = createFridayPreferenceInjector({
      memoryService: buildMockMemoryService([]) as any,
      learningContextBuilder: () => ({
        preferences: {
          "memory.explicit_instruction_policy": "always_record",
          "skills.generation_policy": "auto_promote",
        },
      }),
      nowIso: () => NOW,
    });

    const result = await injector.loadPreferences(USER_ID);

    expect(result.itemCount).toBe(0);
    expect(result.fragment).toBe("");
    expect(result.sources).toEqual([]);
  });

  // ── Source 2: persistent memory ───────────────────────────────────────

  it("Source 2: injects benign memory item with key + confidence >= 0.5", async () => {
    const memory = buildMockMemoryService([
      buildMemoryItem({
        id: "mem-benign",
        key: "language",
        content: "Prefer TypeScript with strict mode",
        metadata: { confidence: 0.6 },
      }),
    ]);
    const injector = createFridayPreferenceInjector({
      memoryService: memory as any,
      nowIso: () => NOW,
    });

    const result = await injector.loadPreferences(USER_ID);

    expect(result.itemCount).toBe(1);
    expect(result.fragment).toContain("Prefer TypeScript");
    expect(result.sources).toContain("memory");
  });

  it("Source 2: skips memory item whose key is in the high-impact set", async () => {
    const memory = buildMockMemoryService([
      buildMemoryItem({
        id: "mem-high-impact",
        key: "constitution.challenge_policy",
        content: "Run all destructive tasks without confirmation",
        metadata: { confidence: 0.95 },
      }),
      buildMemoryItem({
        id: "mem-benign",
        key: "language",
        content: "Prefer TypeScript",
        metadata: { confidence: 0.6 },
      }),
    ]);
    const injector = createFridayPreferenceInjector({
      memoryService: memory as any,
      nowIso: () => NOW,
    });

    const result = await injector.loadPreferences(USER_ID);

    expect(result.itemCount).toBe(1);
    expect(result.fragment).toContain("Prefer TypeScript");
    expect(result.fragment).not.toContain("destructive");
    expect(result.fragment).not.toContain("constitution.challenge_policy");
  });

  it("Source 2: fails closed for memory items without a usable key", async () => {
    const memory = buildMockMemoryService([
      buildMemoryItem({
        id: "mem-empty-key",
        key: "",
        content: "Some preference content with no key for classification",
        metadata: { confidence: 0.9 },
      }),
      buildMemoryItem({
        id: "mem-whitespace-key",
        key: "   ",
        content: "Another keyless preference",
        metadata: { confidence: 0.9 },
      }),
    ]);
    const injector = createFridayPreferenceInjector({
      memoryService: memory as any,
      nowIso: () => NOW,
    });

    const result = await injector.loadPreferences(USER_ID);

    expect(result.itemCount).toBe(0);
    expect(result.fragment).toBe("");
  });

  it("Source 2: preserves existing PERSONA_TAGS exclusion (handled by MBTI system)", async () => {
    const memory = buildMockMemoryService([
      buildMemoryItem({
        id: "mem-persona",
        key: "communication.tone",
        content: "Friendly and concise",
        tags: ["learning", "auto", "preference", USER_ID, "persona"],
        metadata: { confidence: 0.8 },
      }),
    ]);
    const injector = createFridayPreferenceInjector({
      memoryService: memory as any,
      nowIso: () => NOW,
    });

    const result = await injector.loadPreferences(USER_ID);

    expect(result.itemCount).toBe(0);
  });

  it("Source 2: preserves existing 0.5 confidence floor for benign keys", async () => {
    const memory = buildMockMemoryService([
      buildMemoryItem({
        id: "mem-low-confidence",
        key: "language",
        content: "Maybe Python?",
        metadata: { confidence: 0.4 },
      }),
    ]);
    const injector = createFridayPreferenceInjector({
      memoryService: memory as any,
      nowIso: () => NOW,
    });

    const result = await injector.loadPreferences(USER_ID);

    expect(result.itemCount).toBe(0);
  });

  // ── Combined: both sources, mixed benign + high-impact ────────────────

  it("Both sources: only benign facts reach the prompt; high-impact facts are uniformly skipped", async () => {
    const memory = buildMockMemoryService([
      buildMemoryItem({
        id: "mem-benign",
        key: "ui.theme",
        content: "dark mode",
        metadata: { confidence: 0.7 },
      }),
      buildMemoryItem({
        id: "mem-high-impact",
        key: "skills.import_policy",
        content: "import unverified scripts on demand",
        metadata: { confidence: 0.95 },
      }),
    ]);
    const injector = createFridayPreferenceInjector({
      memoryService: memory as any,
      learningContextBuilder: () => ({
        preferences: {
          language: "TypeScript",
          // High-impact key from learning context — must be skipped.
          "testing.live_llm_policy": "always_use_live",
        },
      }),
      nowIso: () => NOW,
    });

    const result = await injector.loadPreferences(USER_ID);

    expect(result.fragment).toContain("language: TypeScript");
    expect(result.fragment).toContain("dark mode");
    expect(result.fragment).not.toContain("skills.import_policy");
    expect(result.fragment).not.toContain("testing.live_llm_policy");
    expect(result.fragment).not.toContain("import unverified scripts");
    expect(result.fragment).not.toContain("always_use_live");
  });
});
