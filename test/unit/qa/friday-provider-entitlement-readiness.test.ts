import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-provider-entitlement-readiness.mjs";

function run(args: string[] = [], expectFailure = false) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (!expectFailure) throw error;
    const stdout = (error as { stdout?: Buffer | string }).stdout?.toString() || "";
    return JSON.parse(stdout);
  }
}

function writeJson(dir: string, name: string, value: unknown) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function proof(provider: "deepseek" | "openai" | "anthropic") {
  if (provider === "deepseek") {
    return {
      proof: "mission_spine_backend_api_live_pressure",
      status: "passed",
      provider_kind: "deepseek",
      deepseek_live_api_pressure: {
        status: "passed",
        real_external_api: true,
      },
    };
  }
  return {
    proof: "provider_entitlement_runtime_api_proof",
    status: "passed",
    provider_kind: provider,
    real_external_api: true,
  };
}

describe("Friday provider entitlement readiness", () => {
  it("blocks without runtime API proofs and keeps free ChatGPT unsupported", () => {
    const report = run([], true);

    expect(report.truth).toBe("provider_entitlement_readiness_not_runtime_generator_not_release");
    expect(report.status).toBe("blocked");
    expect(report.freeChatGptBoundary).toEqual({
      status: "unsupported_as_friday_autonomous_backend",
      mustPassBeforeEndBar: false,
    });
    expect(report.counts.satisfiedProviders).toBe(0);
    expect(report.blockers).toEqual(expect.arrayContaining([
      { code: "provider_runtime_proof_missing", detail: "deepseek_api" },
      { code: "provider_runtime_proof_missing", detail: "openai_api" },
      { code: "provider_runtime_proof_missing", detail: "anthropic_api" },
    ]));
  });

  it("counts DeepSeek proof only for DeepSeek and keeps the matrix blocked until OpenAI and Anthropic proofs are supplied", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-provider-entitlement-"));
    const deepseek = writeJson(dir, "deepseek.json", proof("deepseek"));

    const report = run([`--deepseek-proof=${deepseek}`], true);

    expect(report.status).toBe("blocked");
    expect(report.counts.satisfiedProviders).toBe(1);
    expect(report.providers.find((provider: { providerId: string }) => provider.providerId === "deepseek_api").status).toBe("satisfied");
    expect(report.blockers).toEqual(expect.arrayContaining([
      { code: "provider_runtime_proof_missing", detail: "openai_api" },
      { code: "provider_runtime_proof_missing", detail: "anthropic_api" },
    ]));
  });

  it("passes only when all required API provider proofs match their provider kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-provider-entitlement-"));
    const deepseek = writeJson(dir, "deepseek.json", proof("deepseek"));
    const openai = writeJson(dir, "openai.json", proof("openai"));
    const anthropic = writeJson(dir, "anthropic.json", proof("anthropic"));

    const report = run([
      `--deepseek-proof=${deepseek}`,
      `--openai-proof=${openai}`,
      `--anthropic-proof=${anthropic}`,
    ]);

    expect(report.status).toBe("passed");
    expect(report.counts.satisfiedProviders).toBe(3);
    expect(report.blockers).toEqual([]);
  });

  it("rejects using one provider proof for a different provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-provider-entitlement-"));
    const deepseek = writeJson(dir, "deepseek.json", proof("deepseek"));

    const report = run([`--openai-proof=${deepseek}`], true);

    expect(report.status).toBe("blocked");
    expect(report.providers.find((provider: { providerId: string }) => provider.providerId === "openai_api").blockers).toContainEqual({
      code: "provider_runtime_proof_wrong_provider",
      detail: "openai_api",
    });
  });
});
