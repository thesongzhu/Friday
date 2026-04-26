/**
 * Live execution voice eval with a real model.
 *
 * Gate:
 *   FRIDAY_E2E_LIVE_VOICE=1 plus one live provider lane:
 *   - FRIDAY_E2E_LIVE_OPENAI=1 + OPENAI_API_KEY
 *   - FRIDAY_E2E_LIVE_ANTHROPIC=1 + FRIDAY_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY
 *   - FRIDAY_E2E_LIVE_OLLAMA=1 + local Ollama model
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  buildFridayAgentSystemPrompt,
  createFridayAgentEventEmitter,
  createFridayAgentLlmClient,
  createFridayAgentRuntime,
  evaluateFridayExecutionVoiceResponse,
  type FridayAgentLlmClient,
  type FridayAgentRuntime,
} from "#agent";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../unit/satellites/_helpers/create-test-db.helper.js";
import {
  ANTHROPIC_API_KEY_ENV_REF,
  ANTHROPIC_BASE_URL,
  E2E_GATED,
  FAST_MODEL,
  LIVE_PROVIDER_KIND,
  OLLAMA_BASE_URL,
  OPENAI_API_KEY_ENV,
  OPENAI_BASE_URL,
  ensureAnthropicReady,
  ensureOllamaReady,
  ensureOpenAiReady,
} from "./_helpers/real-env.js";

const LIVE_VOICE_GATED = process.env.FRIDAY_E2E_LIVE_VOICE === "1" && E2E_GATED;
const NOW = "2026-04-26T12:00:00.000Z";

const LIVE_VOICE_SCENARIOS = [
  {
    id: "start_progress" as const,
    task:
      "你正在开始执行任务：检查 OCR 能力闭环是否真实可用。只输出给用户看的进展汇报。一句话或两句话。必须说明你先检查什么，以及为什么这一步重要。不要说“当然可以”或“没问题”。",
  },
  {
    id: "failure_next_step" as const,
    task:
      "真实测试失败：OpenAI text lane 返回 401；日志显示 provider 验证失败。只输出给用户看的失败汇报，必须包含失败点、证据、下一步。不要道歉，不要客服语气。",
  },
  {
    id: "missing_capability" as const,
    task:
      "用户要让 Friday 处理扫描件，但当前没有 OCR capability。只输出给用户看的缺能力说明，必须说明 Friday 可以自己找方案、生成或安装工具、沙箱测试、注册能力，也必须说明账号/API key/付费/验证码需要用户介入。",
  },
  {
    id: "human_gate" as const,
    task:
      "配置第三方 provider 卡在账号和 API key。只输出给用户看的边界说明，必须明确这是人类介入点，也要说除此之外 Friday 可以继续处理什么。",
  },
  {
    id: "assumption_correction" as const,
    task:
      "用户说：是不是 Friday 又忘了调用工具？已知证据：日志里是 401，不是调度失败。只输出给用户看的判断，必须先给证据，再给结论。",
  },
  {
    id: "completion_closeout" as const,
    task:
      "任务已经完成：改动是调度层按 capability 路由；验证是 local closure 已经 GO；剩余风险是没有提供的第三方 provider 不能算真实闭环。只输出给用户看的完成汇报，必须包含改动、验证、剩余风险。",
  },
] as const;

function readAnthropicApiKey(): string {
  const envName = ANTHROPIC_API_KEY_ENV_REF?.replace(/^\$/, "");
  const value = envName ? process.env[envName]?.trim() : "";
  if (!value) {
    throw new Error("Anthropic API key env ref is unavailable");
  }
  return value;
}

function createLiveVoiceLlmClient(): FridayAgentLlmClient {
  return LIVE_PROVIDER_KIND === "openai"
    ? createFridayAgentLlmClient({
      api: "openai-responses",
      baseUrl: OPENAI_BASE_URL,
      apiKey: process.env[OPENAI_API_KEY_ENV]?.trim(),
    })
    : LIVE_PROVIDER_KIND === "anthropic"
      ? createFridayAgentLlmClient({
        api: "anthropic-messages",
        baseUrl: ANTHROPIC_BASE_URL,
        apiKey: readAnthropicApiKey(),
      })
      : createFridayAgentLlmClient({
        api: "ollama",
        baseUrl: OLLAMA_BASE_URL,
        allowPrivateNetwork: true,
      });
}

function sanitizeProviderError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/sk-[A-Za-z0-9_*.-]+/gu, "[redacted-api-key]")
    .replace(/sk-ant-[A-Za-z0-9_*.-]+/gu, "[redacted-api-key]");
}

async function ensureLiveVoiceProviderReady(): Promise<void> {
  if (LIVE_PROVIDER_KIND === "openai") {
    await ensureOpenAiReady({ requiredKeyEnv: OPENAI_API_KEY_ENV });
  } else if (LIVE_PROVIDER_KIND === "anthropic") {
    await ensureAnthropicReady();
  } else {
    await ensureOllamaReady({ requiredModels: [FAST_MODEL] });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    for await (const event of createLiveVoiceLlmClient().stream({
      providerId: `live-${LIVE_PROVIDER_KIND}`,
      model: FAST_MODEL,
      systemPrompt: "Reply with OK only.",
      messages: [{ role: "user", content: "ping" }],
      tools: [],
      signal: controller.signal,
    })) {
      if (event.type === "text_delta" && event.text.trim().length > 0) {
        break;
      }
    }
  } catch (error) {
    throw new Error(
      `[Live voice eval] provider preflight failed for ${LIVE_PROVIDER_KIND}:${FAST_MODEL}. ` +
      `Check the configured live provider credentials before running voice eval. ${sanitizeProviderError(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function createLiveVoiceRuntime(db: FridaySqliteLayer, idGenerator: () => string): Promise<FridayAgentRuntime> {
  const llmClient = createLiveVoiceLlmClient();

  return createFridayAgentRuntime({
    db,
    llmClient,
    model: FAST_MODEL,
    providerId: `live-${LIVE_PROVIDER_KIND}`,
    systemPromptBuilder: (context) => buildFridayAgentSystemPrompt({
      toolNames: context.toolNames,
      modelIdentity: `${FAST_MODEL} (provider: ${LIVE_PROVIDER_KIND})`,
      version: "0.0.0-live-voice",
      currentTime: {
        nowIso: context.nowIso,
        timezone: context.timezone,
        localDate: context.localDate,
      },
    }),
    tools: [],
    eventEmitter: createFridayAgentEventEmitter(),
    idGenerator,
    nowIso: () => NOW,
  });
}

describe.skipIf(!LIVE_VOICE_GATED)(
  `Friday execution voice live eval (${LIVE_PROVIDER_KIND}:${FAST_MODEL})`,
  () => {
    let db: FridaySqliteLayer;
    let idGenerator: () => string;

    beforeEach(() => {
      db = createTestDb();
      idGenerator = createTestIdGenerator();
    });

    afterEach(() => {
      db.close();
    });

    it(
      "real model output satisfies execution voice eval scenarios",
      { timeout: 240_000 },
      async () => {
        await ensureLiveVoiceProviderReady();
        const runtime = await createLiveVoiceRuntime(db, idGenerator);
        const failures: string[] = [];

        for (const scenario of LIVE_VOICE_SCENARIOS) {
          const result = await runtime.executeRun({
            task: scenario.task,
            principalId: "live-voice-eval-user",
            timezone: "America/Los_Angeles",
            timeoutMs: 80_000,
            taskProfile: {
              id: "voice-eval",
              temperature: 0.2,
              reason: "Live execution voice eval needs stable wording.",
            },
          });

          if (result.status !== "completed") {
            failures.push(`${scenario.id}: run status ${result.status}; response=${result.response}`);
            continue;
          }

          const evalResult = evaluateFridayExecutionVoiceResponse({
            scenarioId: scenario.id,
            response: result.response,
          });

          if (!evalResult.passed) {
            failures.push(
              `${scenario.id}: ${evalResult.failures.map((failure) => failure.code).join(", ")}; response=${result.response}`,
            );
          }
        }

        expect(failures).toEqual([]);
      },
    );
  },
);
