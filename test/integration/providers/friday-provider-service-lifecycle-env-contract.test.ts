import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("FridayProviderService lifecycle env-ref contract", () => {
  it("keeps the env-ref create-provider test independent of ambient API keys", () => {
    const source = readFileSync("test/integration/providers/friday-provider-service-lifecycle.test.ts", "utf8");

    expect(source).toMatch(/apiKey:\s*"\$OPENAI_API_KEY",\s*[\r\n]+\s*preserveEnvRef:\s*true,/);
  });
});
