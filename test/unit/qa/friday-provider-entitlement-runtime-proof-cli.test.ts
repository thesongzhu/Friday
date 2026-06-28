import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/run-friday-provider-entitlement-runtime-proof.mjs";

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const stdout = execFileSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      ...env,
    },
  });
  return JSON.parse(stdout);
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Friday provider entitlement runtime proof CLI", () => {
  it("keeps the Anthropic runtime proof default on a currently valid Claude API model", () => {
    const source = readFileSync(script, "utf8");

    expect(source).toContain('model: process.env.FRIDAY_PROVIDER_ENTITLEMENT_ANTHROPIC_MODEL ?? "claude-sonnet-4-6"');
    expect(source).toContain('supportedModels: ["claude-sonnet-4-6", "claude-opus-4-8"]');
    expect(source).not.toContain("claude-sonnet-4-20250514");
    expect(source).not.toContain("claude-opus-4-20250514");
  });

  it("writes honest blocked artifacts when provider API-key env vars are absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-provider-entitlement-proof-"));
    const summary = run(["--provider=all", "--preflight-only", "--allow-missing", `--out-dir=${dir}`]);

    expect(summary.truth).toBe("provider_entitlement_runtime_proof_run_summary");
    expect(summary.status).toBe("partial");
    expect(summary.reports).toHaveLength(3);

    for (const provider of ["deepseek", "openai", "anthropic"]) {
      const proof = readJson(join(dir, `${provider}-runtime-proof.json`));
      expect(proof.proof).toBe("provider_entitlement_runtime_api_proof");
      expect(proof.status).toBe("blocked");
      expect(proof.real_external_api).toBe(false);
      expect(proof.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "provider_api_key_env_missing" }),
      ]));
    }
  });

  it("can preflight a configured provider without requiring a built dist hub", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-provider-entitlement-proof-"));
    const openAiKeyEnv = ["OPENAI", "API", "KEY"].join("_");
    const fakeKey = ["test", "openai", "credential", "not", "used"].join("-");
    const summary = run(
      ["--provider=openai", "--preflight-only", `--out-dir=${dir}`],
      { [openAiKeyEnv]: fakeKey },
    );

    expect(summary.status).toBe("passed");
    expect(summary.reports).toEqual([
      expect.objectContaining({ provider: "openai", status: "preflight_ready" }),
    ]);
    const proof = readJson(join(dir, "openai-runtime-proof.json"));
    expect(proof.provider_kind).toBe("openai");
    expect(proof.status).toBe("preflight_ready");
    expect(proof.real_external_api).toBe(false);
    expect(proof.blockers).toEqual([]);
  });
});
