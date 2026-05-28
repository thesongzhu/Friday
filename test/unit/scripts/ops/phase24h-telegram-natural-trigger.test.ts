import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type ListenerModule = typeof import("../../../../scripts/ops/phase24h-telegram-natural-trigger-listener.mjs");

const scriptUrl = pathToFileURL(
  path.resolve(__dirname, "../../../../scripts/ops/phase24h-telegram-natural-trigger-listener.mjs"),
).href;

async function loadListener(): Promise<ListenerModule> {
  return (await import(`${scriptUrl}?t=${Date.now()}`)) as ListenerModule;
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("phase24h Telegram natural-trigger listener exports", () => {
  it("builds deterministic operator prompts from GitHub run metadata", async () => {
    process.env.GITHUB_RUN_ID = "12345";
    process.env.GITHUB_SHA = "phase24hsha-for-test";
    process.env.FRIDAY_TELEGRAM_BOT_TOKEN = "telegram-token";
    process.env.FRIDAY_TELEGRAM_ALLOWED_USER_ID = "user-1";
    process.env.FRIDAY_TELEGRAM_CHAT_ID = "chat-1";
    process.env.FRIDAY_DEEPSEEK_API_KEY = "deepseek-test-key"; // pragma: allowlist secret

    const listener = await loadListener();
    const config = listener.readEnvConfig();

    expect(config.positiveNonce).toBe("phase24h-positive-run-12345-phase24h");
    expect(config.negativeNonce).toBe("phase24h-negative-run-12345-phase24h");
    expect(config.positiveTriggerText).toContain("PHASE24H_SOP_NATURAL_TRIGGER");
    expect(config.positiveTriggerText).toContain("phase24h-natural-trigger");
    expect(config.positiveTriggerText).toContain("PHASE24H_WORKFLOW_EXECUTED");
    expect(config.positiveTriggerText).toContain("Use memory first");
    expect(config.negativeTriggerText).toContain("PHASE24H_DESTRUCTIVE_CHECK");
    expect(config.deepseekEnvVar).toBe("FRIDAY_DEEPSEEK_API_KEY");
    expect(listener.missingRequiredEnv(config)).toEqual([]);
  });

  it("reports missing DeepSeek env without exposing secret values", async () => {
    process.env.FRIDAY_TELEGRAM_BOT_TOKEN = "telegram-token";
    process.env.FRIDAY_TELEGRAM_ALLOWED_USER_ID = "user-1";
    process.env.FRIDAY_TELEGRAM_CHAT_ID = "chat-1";
    delete process.env.FRIDAY_DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    const listener = await loadListener();
    const config = listener.readEnvConfig();

    expect(listener.missingRequiredEnv(config)).toContain("FRIDAY_DEEPSEEK_API_KEY or DEEPSEEK_API_KEY");
  });

  it("initial report records live-provider intent and no OpenAI fallback", async () => {
    process.env.FRIDAY_DEEPSEEK_API_KEY = "deepseek-test-key"; // pragma: allowlist secret
    const listener = await loadListener();
    const config = listener.readEnvConfig();
    const report = listener.initialReport(config, "/tmp/phase24h.json");

    expect(report.schemaVersion).toBe("friday.phase24h.telegram_natural_trigger_execution_proof.v1");
    expect(report.environment.liveProviderSpendIntent).toMatchObject({
      expectedProvider: "deepseek",
      noSensitiveData: true,
    });
    expect(report.environment.openAiFallbackConfigured).toBe(false);
    expect(report.criteria.noOpenAiFallbackConfigured).toBe(false);
  });

  it("seeds a runtime-supported workflow graph for the live workflow_run proof", async () => {
    const listener = await loadListener();
    const graph = listener.makeWorkflowGraph();

    expect(graph.schemaVersion).toBe("2.0");
    expect(graph.graph.nodes.map((node) => node.type)).toEqual(["trigger", "data"]);
    expect(graph.graph.edges).toEqual([
      { id: "trigger-to-record-proof", sourceNodeId: "trigger", targetNodeId: "record-proof" },
    ]);
    expect(graph.graph.nodes.find((node) => node.id === "record-proof")?.config).toMatchObject({
      mapping: { proofMarker: "PHASE24H_WORKFLOW_EXECUTED" },
    });
  });

  it("resolves the memory service from the API runtime exposed by createFridayHub", async () => {
    const listener = await loadListener();
    const memoryService = {
      store: async () => ({ id: "memory-1" }),
      get: async () => ({ id: "memory-1" }),
    };

    expect(listener.resolveHubMemoryService({ apiRuntime: { memoryService } })).toBe(memoryService);
  });

  it("uses the bootstrap admin user for runtime-owned seeded workflow records", async () => {
    const listener = await loadListener();

    expect(listener.PHASE24H_RUNTIME_USER_ID).toBe("admin-001");
  });
});
