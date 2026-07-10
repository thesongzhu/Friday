import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const LIVE_API_HELPER = "test/e2e/live/_helpers/api.ts";

describe("DeepSeek live provider env-ref contract", () => {
  it("preserves the DeepSeek provider env ref instead of forcing raw-secret encryption", () => {
    const source = readFileSync(LIVE_API_HELPER, "utf8");
    const match = source.match(/export async function createDeepSeekProvider[\s\S]*?apiKey: opts\.apiKeyEnvRef \?\? "\$DEEPSEEK_API_KEY",[\s\S]*?supportedModels:/);

    expect(match?.[0]).toContain('authMode: "bearer-token"');
    expect(match?.[0]).toContain('api: "openai-completions"');
    expect(match?.[0]).toContain("preserveEnvRef: true");
  });
});
