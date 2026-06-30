import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "scripts/ops/phase24-release-proof-prompts.mjs");

function derivePrompts() {
  const stdout = execFileSync(process.execPath, [
    scriptPath,
    "--derive",
    "--run-id",
    "12345",
    "--sha",
    "sha-demo-1234567890",
    "--discord-bot-user-id",
    "bot-1",
    "--json",
    "--require-all",
  ], { encoding: "utf8" });
  return JSON.parse(stdout);
}

describe("phase24-release-proof-prompts derive mode", () => {
  it("derives Phase24 B-G same-run operator messages before live logs are available", () => {
    const report = derivePrompts();

    expect(report).toMatchObject({
      truth_label: "phase24_release_proof_prompt_derivation_read_only_no_channel_send_no_proof_mint",
      complete: true,
      source: {
        kind: "derived-deterministic-workflow-ids",
        run_id: "12345",
        sha: "sha-demo-1234567890",
      },
    });

    const messages = Object.fromEntries(report.phases.map((phase: { id: string; messages: unknown }) => [
      phase.id,
      phase.messages,
    ]));

    expect(messages.phase24b).toEqual({
      message: "<@bot-1> help me clean up old files in my workspace; ask me before doing anything phase24b-run-12345-sha-demo",
    });
    expect(messages.phase24c).toEqual({
      message: "help me clean up old files in my workspace; ask me before doing anything phase24c-run-12345-sha-demo",
    });
    expect(messages.phase24d).toEqual({
      message: "help me clean up old files in my workspace; ask me before doing anything phase24d-run-12345-sha-demo",
    });
    expect(messages.phase24e).toEqual({
      reject: "reject reflex phase24e-reject-run-12345 phase24e-reject-run-12345-sha-demo",
      approve: "approve reflex phase24e-approve-run-12345",
    });
    expect(messages.phase24f).toEqual({
      reject: "reject reflex phase24f-reject-run-12345 phase24f-reject-run-12345-sha-demo <@bot-1>",
      approve: "approve reflex phase24f-approve-run-12345 <@bot-1>",
    });
    expect(messages.phase24g).toEqual({
      reject: "reject reflex phase24g-reject-run-12345 phase24g-reject-run-12345-sha-demo",
      approve: "approve reflex phase24g-approve-run-12345",
    });
  });

  it("fails closed when deriving without the same-run commit sha", () => {
    expect(() =>
      execFileSync(process.execPath, [
        scriptPath,
        "--derive",
        "--run-id",
        "12345",
      ], { encoding: "utf8", stdio: "pipe" }),
    ).toThrow(/Derivation requires --run-id and --sha/);
  });
});
