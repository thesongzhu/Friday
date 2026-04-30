import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import { createFridaySqliteLayer, type FridaySqliteLayer } from "#state";
import { createFridayUixUserPreferenceRepository } from "../../src/uix/persistence/friday-uix-user-preference-repository.js";
import {
  createFridayReflexCandidateRepository,
  createFridayReflexOnboardingRepository,
  createFridayReflexService,
} from "../../src/reflex/index.js";

let db: FridaySqliteLayer | undefined;
let tempDir: string | undefined;
let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `adv-${String(idCounter).padStart(4, "0")}`;
}

function createService() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-reflex-adv-"));
  db = createFridaySqliteLayer({
    dbPath: path.join(tempDir, "state.sqlite"),
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5_000, synchronous: "NORMAL" },
  });
  return createFridayReflexService({
    db,
    candidateRepo: createFridayReflexCandidateRepository(),
    onboardingRepo: createFridayReflexOnboardingRepository(),
    preferenceRepo: createFridayUixUserPreferenceRepository(),
    idGenerator: nextId,
    nowIso: () => "2026-04-30T12:00:00.000Z",
  });
}

afterEach(() => {
  db?.close();
  db = undefined;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  idCounter = 0;
});

describe("Reflex adversarial invariants", () => {
  it("rejects arbitrary onboarding answer payloads without corrupting session progress", () => {
    const service = createService();
    let run = 0;
    fc.assert(
      fc.property(
        fc.record({
          value: fc.string({ maxLength: 32 }).filter((value) => !["follow_input", "zh", "en"].includes(value)),
          extra: fc.dictionary(fc.string({ maxLength: 12 }), fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))),
        }),
        (payload) => {
          run += 1;
          const userId = `user-adv-${String(run)}`;
          service.startOnboarding({ userId, primaryChannelKind: "telegram" });
          try {
            service.answerOnboarding({
              userId,
              questionId: "O1",
              answer: { ...payload.extra, value: payload.value },
              sourceSurface: "channel",
            });
            throw new Error("Invalid payload was unexpectedly accepted");
          } catch {
            const snapshot = service.getOnboarding(userId);
            expect(snapshot.session?.status).toBe("active");
            expect(snapshot.activeQuestion?.id).toBe("O1");
            expect(snapshot.progress.completed).toBe(0);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it("keeps explicit opposite memory instructions above inferred candidates", async () => {
    const service = createService();
    service.updatePreference({
      userId: "user-adv",
      category: "reflex",
      key: "memory.explicit_instruction_policy",
      value: "session_only",
      sourceSurface: "operate",
    });
    const candidate = service.createCandidate({
      userId: "user-adv",
      kind: "preference",
      origin: "channel",
      title: "Infer always save explicit memory",
      summary: "An ambiguous channel message looked like a durable memory preference.",
      payload: {
        category: "reflex",
        key: "memory.explicit_instruction_policy",
        value: "save_immediately",
      },
      evidence: {
        adversarialCase: "do not remember this vs remember this",
      },
      confidence: 0.91,
      riskTier: 1,
    });

    await service.approveCandidate({ userId: "user-adv", candidateId: candidate.id });
    const pref = service.listPreferences("user-adv")
      .find((item) => item.category === "reflex" && item.key === "memory.explicit_instruction_policy");
    expect(pref?.source).toBe("explicit");
    expect(pref?.value).toBe("session_only");
  });
});
