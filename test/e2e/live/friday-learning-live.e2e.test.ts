import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiFetch, createOpenAiProvider } from "./_helpers/api.js";
import { pollUntil } from "./_helpers/poll.js";
import {
  cleanupRealHubEnv,
  createRealHubEnv,
  E2E_GATED,
  FAST_MODEL,
  LIVE_PROVIDER_KIND,
  OPENAI_API_KEY_ENV,
  OPENAI_BASE_URL,
  type RealHubEnv,
} from "./_helpers/real-env.js";

const OPENAI_PROOF_GATED = E2E_GATED && LIVE_PROVIDER_KIND === "openai";
const LIVE_MODEL = FAST_MODEL;

interface SessionRunResponse {
  ok: boolean;
  data: {
    run: {
      runId: string;
      status: string;
      response: string;
      toolCallCount: number;
      durationMs: number;
      usageInput: number;
      usageOutput: number;
    };
    messages: Array<{ role: string; content: string }>;
  };
}

interface CompactionEventRow {
  eventName: string;
  payloadJson: string;
}

interface MemoryRow {
  namespace: string;
  content: string;
  source: string;
  tagsJson: string;
  createdAt: string;
}

interface SessionMessageRecord {
  id: string;
  role: string;
  contentText: string;
  createdAt: string;
}

interface WorldModelEvidence {
  episodeCount: number;
  snapshotCount: number;
  matchedTasks: string[];
}

function readCompactionEvents(dbPath: string, createdAfterIso: string): CompactionEventRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(
      `SELECT event_name AS eventName, payload_json AS payloadJson
         FROM friday_agent_run_events
        WHERE created_at >= ?
          AND event_name LIKE 'agent.run.compaction_%'
        ORDER BY created_at ASC, seq ASC`,
    ).all(createdAfterIso) as CompactionEventRow[];
  } finally {
    db.close();
  }
}

function readCompactionMemoryRows(dbPath: string, createdAfterIso: string): MemoryRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(
      `SELECT namespace, content_text AS content, source, tags_json AS tagsJson, created_at AS createdAt
         FROM memory_items
        WHERE created_at >= ?
          AND namespace LIKE 'compaction.%'
        ORDER BY updated_at DESC`,
    ).all(createdAfterIso) as MemoryRow[];
  } finally {
    db.close();
  }
}

function readWorldModelEvidence(dbPath: string, userId: string, taskToken: string): WorldModelEvidence {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const matchedTasks = db.prepare(
      `SELECT task_intent
         FROM friday_episodes
        WHERE user_id = ?
          AND task_intent LIKE ?
        ORDER BY created_at DESC`,
    ).all(userId, `%${taskToken}%`) as Array<{ task_intent: string }>;

    const snapshotCount = db.prepare(
      `SELECT COUNT(*) AS count
         FROM friday_world_state_snapshots
        WHERE user_id = ?`,
    ).get(userId) as { count: number };

    return {
      episodeCount: matchedTasks.length,
      snapshotCount: snapshotCount.count,
      matchedTasks: matchedTasks.map((row) => row.task_intent),
    };
  } finally {
    db.close();
  }
}

async function ensureOpenAiLearningProvider(
  env: RealHubEnv,
  name: string,
): Promise<string> {
  return createOpenAiProvider(env.baseUrl, env.accessToken, {
    name,
    openAiBaseUrl: OPENAI_BASE_URL,
    models: [LIVE_MODEL],
    defaultModel: LIVE_MODEL,
    apiKeyEnvRef: `$${OPENAI_API_KEY_ENV}`,
  });
}

async function readAuthenticatedUserId(env: RealHubEnv): Promise<string> {
  const response = await apiFetch<{
    ok: boolean;
    data: {
      user: {
        id: string;
      };
    };
  }>(env.baseUrl, env.accessToken, "GET", "/v1/auth/me");
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  expect(response.json.data.user.id.trim().length).toBeGreaterThan(0);
  return response.json.data.user.id.trim();
}

describe.skipIf(!OPENAI_PROOF_GATED)("Friday Learning Live (OpenAI API key)", () => {
  let env: RealHubEnv;
  let providerId: string;

  beforeAll(async () => {
    env = await createRealHubEnv();
    providerId = await ensureOpenAiLearningProvider(env, "Learning Live OpenAI");
  }, 60_000);

  afterAll(async () => {
    if (env) {
      await cleanupRealHubEnv(env);
    }
  }, 30_000);

  it(
    "proves session memory write -> readback changes behavior inside the same live session",
    { timeout: 120_000, retry: 1 },
    async () => {
      const sessionKey = `session-memory-live-${Date.now().toString(36)}`;
      const controlSessionKey = `${sessionKey}-control`;
      const marker = `SESSION-MARKER-${Date.now().toString(36).toUpperCase()}`;

      const seededMessage = await apiFetch<{
        ok: boolean;
        data: {
          message: SessionMessageRecord;
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
        {
          role: "user",
          content: `For the rest of this session, the exact canonical marker is ${marker}. If I ask for the canonical marker later, return exactly ${marker}.`,
        },
      );
      expect(seededMessage.status).toBe(200);
      expect(seededMessage.json.ok).toBe(true);

      const seededMessages = await apiFetch<{
        ok: boolean;
        data: { items: SessionMessageRecord[] };
      }>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
      );
      expect(seededMessages.status).toBe(200);
      expect(seededMessages.json.ok).toBe(true);
      expect(
        seededMessages.json.data.items.some((item) => item.contentText.includes(marker)),
      ).toBe(true);

      const recallTask = "What is the canonical marker for this session? Answer with the marker only. If unknown, answer UNKNOWN.";

      const controlRun = await apiFetch<SessionRunResponse>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/sessions/${encodeURIComponent(controlSessionKey)}/run`,
        {
          task: recallTask,
          providerId,
          model: LIVE_MODEL,
          timeoutMs: 90_000,
        },
        { timeoutMs: 100_000 },
      );
      expect(controlRun.status).toBe(200);
      expect(controlRun.json.ok).toBe(true);
      expect(controlRun.json.data.run.status).toBe("completed");

      const seededRun = await apiFetch<SessionRunResponse>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionKey)}/run`,
        {
          task: recallTask,
          providerId,
          model: LIVE_MODEL,
          timeoutMs: 90_000,
        },
        { timeoutMs: 100_000 },
      );
      expect(seededRun.status).toBe(200);
      expect(seededRun.json.ok).toBe(true);
      expect(seededRun.json.data.run.status).toBe("completed");

      expect(controlRun.json.data.run.response.includes(marker)).toBe(false);
      expect(seededRun.json.data.run.response).toContain(marker);
    },
  );

  it(
    "proves compaction trigger -> writeback -> reset -> readback changes behavior over a real session",
    { timeout: 240_000, retry: 1 },
    async () => {
      const sessionKey = `compaction-live-${Date.now().toString(36)}`;
      const controlSessionKey = `${sessionKey}-control`;
      const proofDir = path.join(os.tmpdir(), "friday-learning-live-proof", sessionKey);
      fs.mkdirSync(proofDir, { recursive: true });

      const evidenceToken = `EVIDENCE-TOKEN-${Date.now().toString(36).toUpperCase()}`;
      const largePayload = [
        "retention-proof payload start",
        `canonical evidence token ${evidenceToken}`,
        "pilot channel discord remains the primary channel",
        "recall this exactly during the later recap",
        "retention filler ".repeat(480).trim(),
        "retention-proof payload end",
      ].join(" ");

      for (let index = 0; index < 7; index++) {
        const userContent =
          `Retention proof user segment ${String(index + 1)}. ` +
          `The canonical evidence token is ${evidenceToken}. ${largePayload}`;
        const assistantContent =
          `Retention proof assistant segment ${String(index + 1)}. ` +
          `I confirm the canonical evidence token remains ${evidenceToken} ` +
          `and the pilot channel remains Discord. ${largePayload}`;

        const userMessageRes = await apiFetch<{ ok: boolean }>(
          env.baseUrl,
          env.accessToken,
          "POST",
          `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
          { role: "user", content: userContent },
        );
        expect(userMessageRes.status).toBe(200);
        expect(userMessageRes.json.ok).toBe(true);

        const assistantMessageRes = await apiFetch<{ ok: boolean }>(
          env.baseUrl,
          env.accessToken,
          "POST",
          `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
          { role: "assistant", content: assistantContent },
        );
        expect(assistantMessageRes.status).toBe(200);
        expect(assistantMessageRes.json.ok).toBe(true);
      }

      const createdAfterIso = new Date().toISOString();

      const primingRun = await apiFetch<SessionRunResponse>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionKey)}/run`,
        {
          task:
            "Summarize the prior retention proof discussion in one short sentence, " +
            "including the exact canonical evidence token.",
          providerId,
          model: LIVE_MODEL,
          timeoutMs: 90_000,
        },
        { timeoutMs: 100_000 },
      );
      expect(primingRun.status).toBe(200);
      expect(primingRun.json.ok).toBe(true);
      expect(primingRun.json.data.run.status).toBe("completed");
      expect(primingRun.json.data.run.response).toContain(evidenceToken);

      const dbPath = path.join(env.stateDir!, "friday.db");
      const compactionEvents = await pollUntil(
        async () => readCompactionEvents(dbPath, createdAfterIso),
        (rows) => rows.some((row) => row.eventName === "agent.run.compaction_result"),
        { intervalMs: 500, maxMs: 30_000 },
      );
      expect(compactionEvents.some((row) => row.eventName === "agent.run.compaction_attempted")).toBe(true);
      expect(compactionEvents.some((row) => row.eventName === "agent.run.compaction_persist_scheduled")).toBe(true);

      const resultPayload = compactionEvents
        .filter((row) => row.eventName === "agent.run.compaction_result")
        .map((row) => JSON.parse(row.payloadJson) as Record<string, unknown>)
        .find((payload) => payload.compacted === true);
      expect(resultPayload).toBeTruthy();
      expect(resultPayload?.summaryPresent).toBe(true);

      const compactionRows = await pollUntil(
        async () => readCompactionMemoryRows(dbPath, createdAfterIso),
        (rows) => rows.some((row) => row.namespace === "compaction.summary"),
        { intervalMs: 500, maxMs: 30_000 },
      );
      const namespaces = new Set(compactionRows.map((row) => row.namespace));
      expect(namespaces.has("compaction.summary")).toBe(true);
      expect(compactionRows.some((row) => row.content.includes(evidenceToken))).toBe(true);

      const resetRes = await apiFetch<{ ok: boolean }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionKey)}/reset`,
      );
      expect(resetRes.status).toBe(200);
      expect(resetRes.json.ok).toBe(true);

      const recallTask =
        "The previous session context may include a canonical evidence token. " +
        "Return the exact canonical evidence token from that previous session context. " +
        "Answer with the token only. If unknown, answer UNKNOWN.";

      const controlEnv = await createRealHubEnv();
      let controlProviderId = "";
      try {
        controlProviderId = await ensureOpenAiLearningProvider(controlEnv, "Learning Live Control OpenAI");

        const controlRun = await apiFetch<SessionRunResponse>(
          controlEnv.baseUrl,
          controlEnv.accessToken,
          "POST",
          `/v1/sessions/${encodeURIComponent(controlSessionKey)}/run`,
          {
            task: recallTask,
            providerId: controlProviderId,
            model: LIVE_MODEL,
            timeoutMs: 90_000,
          },
          { timeoutMs: 100_000 },
        );
        expect(controlRun.status).toBe(200);
        expect(controlRun.json.ok).toBe(true);
        expect(controlRun.json.data.run.status).toBe("completed");

        const recallRun = await apiFetch<SessionRunResponse>(
          env.baseUrl,
          env.accessToken,
          "POST",
          `/v1/sessions/${encodeURIComponent(sessionKey)}/run`,
          {
            task: recallTask,
            providerId,
            model: LIVE_MODEL,
            timeoutMs: 90_000,
          },
          { timeoutMs: 100_000 },
        );
        fs.writeFileSync(
          path.join(proofDir, "trace.json"),
          JSON.stringify({
            sessionKey,
            controlSessionKey,
            evidenceToken,
            compactionEvents,
            compactionRows,
            controlRun: controlRun.json,
            recallRun: recallRun.json,
          }, null, 2),
        );
        expect(recallRun.status).toBe(200);
        expect(recallRun.json.ok).toBe(true);
        expect(recallRun.json.data.run.status).toBe("completed");
        expect(controlRun.json.data.run.response.includes(evidenceToken)).toBe(false);
        expect(recallRun.json.data.run.response).toContain(evidenceToken);
      } finally {
        await cleanupRealHubEnv(controlEnv);
      }
    },
  );

  it(
    "proves world-model recent interactions write -> readback changes behavior across fresh sessions for the same user",
    { timeout: 180_000, retry: 1 },
    async () => {
      const taskToken = `WM-${Date.now().toString(36).toUpperCase()}`;
      const seedChatId = `world-seed-${Date.now().toString(36)}`;
      const recallChatId = `${seedChatId}-recall`;
      const controlChatId = `${seedChatId}-control`;
      const isolatedEnv = await createRealHubEnv();
      const controlEnv = await createRealHubEnv();
      try {
        const isolatedProviderId = await ensureOpenAiLearningProvider(isolatedEnv, "Learning World Model OpenAI");
        const controlProviderId = await ensureOpenAiLearningProvider(controlEnv, "Learning World Model Control OpenAI");
        const principalUserId = await readAuthenticatedUserId(isolatedEnv);

        const createSeedSession = await apiFetch<{
          ok: boolean;
          data: {
            session: { sessionKey: string };
          };
        }>(isolatedEnv.baseUrl, isolatedEnv.accessToken, "POST", "/v1/sessions", {
          channel: "web",
          chatId: seedChatId,
          chatKind: "dm",
        });
        expect(createSeedSession.status).toBe(200);
        expect(createSeedSession.json.ok).toBe(true);
        const seedSessionKey = createSeedSession.json.data.session.sessionKey;

        const seedRun = await apiFetch<SessionRunResponse>(
          isolatedEnv.baseUrl,
          isolatedEnv.accessToken,
          "POST",
          `/v1/sessions/${encodeURIComponent(seedSessionKey)}/run`,
          {
            task:
              `This is a recent-interactions retention marker. ` +
              `The exact release codename is ${taskToken}. ` +
              `Reply with ACK ${taskToken} and nothing else.`,
            providerId: isolatedProviderId,
            model: LIVE_MODEL,
            timeoutMs: 90_000,
          },
          { timeoutMs: 100_000 },
        );
        expect(seedRun.status).toBe(200);
        expect(seedRun.json.ok).toBe(true);
        expect(seedRun.json.data.run.status).toBe("completed");
        expect(seedRun.json.data.run.response).toContain(taskToken);

        const dbPath = path.join(isolatedEnv.stateDir!, "friday.db");
        const worldEvidence = await pollUntil(
          async () => readWorldModelEvidence(dbPath, principalUserId, taskToken),
          (evidence) => evidence.episodeCount >= 1 && evidence.snapshotCount >= 1,
          { intervalMs: 500, maxMs: 20_000 },
        );
        expect(worldEvidence.matchedTasks.some((task) => task.includes(taskToken))).toBe(true);

        const createRecallSession = await apiFetch<{
          ok: boolean;
          data: {
            session: { sessionKey: string };
          };
        }>(isolatedEnv.baseUrl, isolatedEnv.accessToken, "POST", "/v1/sessions", {
          channel: "web",
          chatId: recallChatId,
          chatKind: "dm",
        });
        expect(createRecallSession.status).toBe(200);
        expect(createRecallSession.json.ok).toBe(true);

        const createControlSession = await apiFetch<{
          ok: boolean;
          data: {
            session: { sessionKey: string };
          };
        }>(controlEnv.baseUrl, controlEnv.accessToken, "POST", "/v1/sessions", {
          channel: "web",
          chatId: controlChatId,
          chatKind: "dm",
        });
        expect(createControlSession.status).toBe(200);
        expect(createControlSession.json.ok).toBe(true);

        const recallTask =
          "Read any recent-interactions context available to you. " +
          `Return the exact release codename from that context. ` +
          "Answer with the codename only. If absent, answer UNKNOWN.";

        const recallRun = await apiFetch<SessionRunResponse>(
          isolatedEnv.baseUrl,
          isolatedEnv.accessToken,
          "POST",
          `/v1/sessions/${encodeURIComponent(createRecallSession.json.data.session.sessionKey)}/run`,
          {
            task: recallTask,
            providerId: isolatedProviderId,
            model: LIVE_MODEL,
            timeoutMs: 90_000,
          },
          { timeoutMs: 100_000 },
        );
        expect(recallRun.status).toBe(200);
        expect(recallRun.json.ok).toBe(true);
        expect(recallRun.json.data.run.status).toBe("completed");

        const controlRun = await apiFetch<SessionRunResponse>(
          controlEnv.baseUrl,
          controlEnv.accessToken,
          "POST",
          `/v1/sessions/${encodeURIComponent(createControlSession.json.data.session.sessionKey)}/run`,
          {
            task: recallTask,
            providerId: controlProviderId,
            model: LIVE_MODEL,
            timeoutMs: 90_000,
          },
          { timeoutMs: 100_000 },
        );
        expect(controlRun.status).toBe(200);
        expect(controlRun.json.ok).toBe(true);
        expect(controlRun.json.data.run.status).toBe("completed");

        expect(controlRun.json.data.run.response.includes(taskToken)).toBe(false);
        expect(recallRun.json.data.run.response).toContain(taskToken);
      } finally {
        await cleanupRealHubEnv(controlEnv);
        await cleanupRealHubEnv(isolatedEnv);
      }
    },
  );
});
