/**
 * Preference Injector: merges learned preferences from the self-learning
 * pipeline and persistent memory into a prompt fragment for injection
 * into the system prompt.
 *
 * Deduplication ensures no overlap with the Persona/MBTI communication
 * prompt builder (which handles tone, verbosity, directness separately).
 */

import type { FridayMemoryService } from "../../memory/services/friday-memory-service.types.js";
import { isFridayReflexConfirmationRequiredKey } from "../../reflex/index.js";

// ─── Types ───

export interface FridayPreferenceInjectionResult {
  /** Prompt-ready text fragment. Empty string if no preferences found. */
  fragment: string;
  /** Number of preference items included. */
  itemCount: number;
  /** Source labels for traceability (e.g. "learning", "memory"). */
  sources: string[];
}

export interface FridayPreferenceInjector {
  loadPreferences(userId: string): Promise<FridayPreferenceInjectionResult>;
}

// ─── Constants ───

/** Maximum preferences to inject (prevents prompt bloat). */
const MAX_PREFERENCE_ITEMS = 12;

/** Minimum confidence to include a preference. */
const MIN_CONFIDENCE_THRESHOLD = 0.5;

/** Tags that indicate a preference is handled by the Persona/MBTI system. */
const PERSONA_TAGS = new Set(["persona", "communication_style", "mbti", "tone", "verbosity", "directness"]);

// ─── Factory ───

export interface CreateFridayPreferenceInjectorDeps {
  memoryService: FridayMemoryService;
  /**
   * Optional existing learning context builder.
   * Returns preferences from the Bayesian self-learning pipeline.
   */
  learningContextBuilder?: (input: { userId: string; nowIso: string }) => {
    preferences: Record<string, unknown>;
  };
  nowIso: () => string;
}

export function createFridayPreferenceInjector(
  deps: CreateFridayPreferenceInjectorDeps,
): FridayPreferenceInjector {
  const { memoryService, learningContextBuilder, nowIso } = deps;

  return {
    async loadPreferences(userId) {
      const sources: string[] = [];
      const items: Array<{ text: string; confidence: number; source: string }> = [];

      // High-impact learned preferences (keys the Reflex 17-key set already
      // gates as confirmation-required for UIX preferences) must NOT be
      // auto-injected via the learned-fact path. They share the same risk
      // shape (memory/automation/skills/safety/etc. policy) and the
      // learned-fact pipeline has no equivalent of the UIX confirmation
      // surface. Until that surface exists, we fail closed for these keys
      // on both Source 1 and Source 2 paths.
      // High-impact learned preference confirmation UX still needed;
      // re-evaluate when Review Center / candidate-preference confirmation
      // exists for learning.preferences.

      // ── Source 1: Learning pipeline (Bayesian preferences) ──
      if (learningContextBuilder) {
        try {
          const ctx = learningContextBuilder({ userId, nowIso: nowIso() });
          if (ctx.preferences && typeof ctx.preferences === "object") {
            for (const [key, value] of Object.entries(ctx.preferences)) {
              if (value != null && String(value).trim().length > 0) {
                if (isFridayReflexConfirmationRequiredKey(key)) {
                  // Fail closed: high-impact learned key, no confirmation path.
                  continue;
                }
                items.push({
                  text: `${key}: ${String(value)}`,
                  confidence: 0.8, // Learning pipeline default confidence
                  source: "learning",
                });
              }
            }
            if (items.length > 0) sources.push("learning");
          }
        } catch {
          // Non-fatal: learning pipeline failure shouldn't block preferences
        }
      }

      // ── Source 2: Persistent memory (true preference items only) ──
      // Do NOT read compaction.* here. Compaction memory is session-scoped
      // operational context, not a user preference. Injecting it globally
      // leaks one session's retained facts into unrelated sessions.
      try {
        const memoryItems = await memoryService.list({
          namespace: ["learning.preferences"],
          tagsAny: [userId],
          limit: 20,
        });

        for (const item of memoryItems) {
          // Skip items with persona-related tags (handled by MBTI system)
          const tags = item.tags ?? [];
          if (!tags.includes(userId) || !tags.includes("preference")) continue;
          if (tags.some((tag: string) => PERSONA_TAGS.has(tag.toLowerCase()))) continue;

          // Fail closed if the item carries no usable key: without a key the
          // injector cannot classify whether the fact is high-impact or
          // benign, so we skip rather than guess.
          const itemKey = typeof item.key === "string" ? item.key.trim() : "";
          if (itemKey.length === 0) continue;
          if (isFridayReflexConfirmationRequiredKey(itemKey)) {
            // Fail closed: high-impact learned key, no confirmation path.
            continue;
          }

          const content = item.content ?? "";
          if (content.trim().length === 0) continue;

          const confidence = (item.metadata?.confidence as number | undefined) ?? 0.6;
          if (confidence < MIN_CONFIDENCE_THRESHOLD) continue;

          items.push({
            text: content.slice(0, 200), // Clamp for prompt size
            confidence,
            source: "memory",
          });
        }
        if (memoryItems.length > 0) sources.push("memory");
      } catch {
        // Non-fatal: memory search failure shouldn't block preferences
      }

      // ── Deduplicate by token overlap ──
      const deduped = deduplicatePreferences(items);

      // ── Sort by confidence descending and limit ──
      deduped.sort((a, b) => b.confidence - a.confidence);
      const selected = deduped.slice(0, MAX_PREFERENCE_ITEMS);

      if (selected.length === 0) {
        return { fragment: "", itemCount: 0, sources: [] };
      }

      // ── Format as prompt fragment ──
      const lines = selected.map(
        (item) => `- ${item.text} (confidence: ${item.confidence.toFixed(2)}, source: ${item.source})`,
      );
      const fragment = `[Learned Preferences]\n${lines.join("\n")}`;

      return {
        fragment,
        itemCount: selected.length,
        sources: [...new Set(sources)],
      };
    },
  };
}

// ─── Helpers ───

/**
 * Simple token-overlap deduplication.
 * If two items share > 80% of their tokens, keep the higher-confidence one.
 */
function deduplicatePreferences(
  items: Array<{ text: string; confidence: number; source: string }>,
): Array<{ text: string; confidence: number; source: string }> {
  if (items.length <= 1) return items;

  const tokenized = items.map((item) => ({
    ...item,
    tokens: new Set(
      item.text
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/)
        .filter((t) => t.length >= 2),
    ),
  }));

  const keep: boolean[] = new Array(tokenized.length).fill(true);

  for (let i = 0; i < tokenized.length; i++) {
    if (!keep[i]) continue;
    for (let j = i + 1; j < tokenized.length; j++) {
      if (!keep[j]) continue;

      const a = tokenized[i];
      const b = tokenized[j];
      const smaller = Math.min(a.tokens.size, b.tokens.size);
      if (smaller === 0) continue;

      let overlap = 0;
      for (const token of a.tokens) {
        if (b.tokens.has(token)) overlap++;
      }

      if (overlap / smaller > 0.8) {
        // Keep the higher-confidence item
        if (a.confidence >= b.confidence) {
          keep[j] = false;
        } else {
          keep[i] = false;
          break;
        }
      }
    }
  }

  return tokenized.filter((_, i) => keep[i]);
}
