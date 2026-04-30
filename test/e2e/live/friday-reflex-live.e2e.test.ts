import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFridaySqliteLayer, type FridaySqliteLayer } from "#state";
import { createFridayUixUserPreferenceRepository } from "../../../src/uix/persistence/friday-uix-user-preference-repository.js";
import {
  createFridayReflexCandidateRepository,
  createFridayReflexOnboardingRepository,
  createFridayReflexService,
} from "../../../src/reflex/index.js";

const LIVE_ENABLED = process.env.FRIDAY_REFLEX_LIVE_PROFILE === "1";

let db: FridaySqliteLayer | undefined;
let tempDir: string | undefined;
let idCounter = 0;

function requireLiveEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required when FRIDAY_REFLEX_LIVE_PROFILE=1`);
  }
  return value.trim();
}

function nextId(): string {
  idCounter += 1;
  return `live-reflex-${String(idCounter).padStart(4, "0")}`;
}

function createService() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-reflex-live-"));
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
    nowIso: () => new Date().toISOString(),
  });
}

async function callOpenAiCompatibleJson(input: string): Promise<Record<string, unknown>> {
  const baseUrl = requireLiveEnv("FRIDAY_REFLEX_LIVE_BASE_URL").replace(/\/+$/u, "");
  const apiKey = requireLiveEnv("FRIDAY_REFLEX_LIVE_API_KEY");
  const model = requireLiveEnv("FRIDAY_REFLEX_LIVE_MODEL");
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "Return only compact JSON. Classify explicit durable preferences separately from ambiguous behavior.",
        },
        { role: "user", content: input },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Live Reflex model request failed with HTTP ${String(response.status)}`);
  }
  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Live Reflex model returned no content");
  return JSON.parse(content) as Record<string, unknown>;
}

afterEach(() => {
  db?.close();
  db = undefined;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  idCounter = 0;
});

describe.runIf(LIVE_ENABLED)("Friday Reflex live LLM profile", () => {
  it("fails clearly when required provider env is missing", () => {
    expect(requireLiveEnv("FRIDAY_REFLEX_LIVE_BASE_URL")).toBeTruthy();
    expect(requireLiveEnv("FRIDAY_REFLEX_LIVE_API_KEY")).toBeTruthy();
    expect(requireLiveEnv("FRIDAY_REFLEX_LIVE_MODEL")).toBeTruthy();
  });

  it("verifies explicit preferences write immediately while ambiguous preferences become candidates", async () => {
    const modelResult = await callOpenAiCompatibleJson(
      "Return JSON with keys explicitShorter and ambiguousWorkflow. Sentence A: '以后回答短一点'. Sentence B: 'I keep doing this export flow a lot'. Values must be booleans.",
    );
    expect(modelResult.explicitShorter).toBe(true);
    expect(modelResult.ambiguousWorkflow).toBe(false);

    const service = createService();
    service.updatePreference({
      userId: "live-user",
      category: "communication",
      key: "persona.verbosity",
      value: "concise",
      sourceSurface: "operate",
    });
    const candidate = service.createCandidate({
      userId: "live-user",
      kind: "workflow",
      origin: "post_run",
      title: "Repeated export flow",
      summary: "Ambiguous repeated behavior should stay a workflow candidate.",
      payload: { goal: "Draft a workflow for a repeated export flow." },
      confidence: 0.62,
      riskTier: 2,
    });

    expect(service.listPreferences("live-user").find((pref) => pref.key === "persona.verbosity")?.value)
      .toBe("concise");
    expect(candidate.status).toBe("proposed");
  });
});
