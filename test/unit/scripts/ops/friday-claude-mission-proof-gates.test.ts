import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const proofScript = resolve(
  repoRoot,
  "scripts/ops/friday-claude-mission-proof-of-life.sh",
);
const keychainWrapper = resolve(
  repoRoot,
  "scripts/ops/friday-claude-mission-proof-of-life-keychain.sh",
);

describe("Claude mission proof operator gate", () => {
  it("keeps the script shell-parseable", () => {
    for (const script of [proofScript, keychainWrapper]) {
      const result = spawnSync("bash", ["-n", script], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("requires Claude WorkItem proof joined to Anthropic ledger before strong pass", () => {
    const source = readFileSync(proofScript, "utf8");

    expect(source).toContain("FRIDAY_CLAUDE_MISSION_PROOF_PREFLIGHT_ONLY");
    expect(source).toContain("FRIDAY_CLAUDE_MISSION_PROOF_PASSPHRASE_STDIN");
    expect(source).toContain("FRIDAY_CLAUDE_MISSION_PROOF_OUTCOME_CHECKED");
    expect(source).toContain('readonly CLAUDE_MODEL="claude-opus-4-8"');
    expect(source).toContain('lane: "claude"');
    expect(source).toContain('targetProviderOrAgent: "claude"');
    expect(source).toContain('proofRequirements: ["outcome:AnswerProduced:>=1"]');
    expect(source).toContain(
      'deliveryRoute: "ops://claude-mission-proof-of-life"',
    );
    expect(source).toContain(
      'require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "export FRIDAY_CLAUDE_ROUTE_ENABLED=1"',
    );
    expect(source).toContain(
      'require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "--validate-claude"',
    );
    expect(source).toContain(
      'require_schema_column "token_ledger" "run_id"',
    );
    expect(source).toContain(
      'require_schema_column "token_ledger" "provider_kind"',
    );
    expect(source).toContain(
      'require_schema_column "work_item" "proof_receipts"',
    );
    expect(source).toContain("status='completed_with_proof'");
    expect(source).toContain(
      "p.proof_receipt = 'friday://agent-run/' || ledger.run_id",
    );
    expect(source).toContain("proof://outcome/AnswerProduced/");
    expect(source).toContain("answer_len");
    expect(source).toContain("CAST(p.answer_len AS INTEGER) > 0");
    expect(source).toContain("ledger.provider_kind='anthropic'");
    expect(source).toContain("ledger.model='${CLAUDE_MODEL}'");
    expect(source).toContain("ledger.fallback=0");
    expect(source).toContain("ledger.total_tokens > 0");
    expect(source).toContain("surface.surface_kind = 'mobile'");
    expect(source).toContain(
      "surface.delivery_route = 'ops://claude-mission-proof-of-life'",
    );
    expect(source).toContain("PASS (STRONG)");
    expect(source).toContain("PASS (PARTIAL)");
    expect(source).toContain("PASS (STRONG OUTCOME)");
    expect(source).toContain("PASS (PARTIAL OUTCOME)");
    expect(source).toContain(
      "Truth: operator-triggered Claude mission proof, not D8 / not soak / not UI-device-channel proof / not GO.",
    );

    expect(source).not.toContain("provider_session_event");
    expect(source).not.toContain("provider_session_link");
    expect(source).not.toContain("process_observation");
    expect(source).not.toContain("codex_app_server");
  });

  it("does not read secrets before preflight and does not put bearer in argv", () => {
    const source = readFileSync(proofScript, "utf8");
    const preflightIndex = source.indexOf(
      'if [ "${PREFLIGHT_ONLY}" = "1" ]; then',
    );
    const hiddenReadIndex = source.indexOf("read -rs PASSPHRASE");

    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(hiddenReadIndex).toBeGreaterThanOrEqual(0);
    expect(preflightIndex).toBeLessThan(hiddenReadIndex);
    expect(
      source.indexOf('tcp_port_ok "${RUST_WS_HOST}" "${RUST_WS_PORT}"'),
    ).toBeLessThan(hiddenReadIndex);
    expect(
      source.indexOf(
        'require_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_MISSION_AUTO_DISPATCH" "1"',
      ),
    ).toBeLessThan(hiddenReadIndex);
    expect(
      source.indexOf(
        'require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_MISSION_AUTO_DISPATCH" "1"',
      ),
    ).toBeLessThan(hiddenReadIndex);
    expect(
      source.indexOf('require_schema_column "token_ledger" "run_id"'),
    ).toBeLessThan(hiddenReadIndex);

    expect(source).toContain("curl_bearer_json()");
    expect(source).toContain("curl --config -");
    expect(source).not.toContain('-H "Authorization: Bearer');
    expect(source).not.toContain("-H 'Authorization: Bearer");
    expect(source).not.toContain("Authorization: Bearer ${TOKEN}");
  });

  it("runs keychain preflight before reading a provisioned passphrase", () => {
    const source = readFileSync(keychainWrapper, "utf8");

    expect(source).toContain("FRIDAY_CLAUDE_MISSION_PROOF_PREFLIGHT_ONLY=1");
    expect(source).toContain(
      'FRIDAY_CLAUDE_MISSION_PROOF_PASSPHRASE_STDIN=1 "${PROOF_SCRIPT}"',
    );
    expect(source).toContain("passphrase_file_ok()");
    expect(source).toContain("read_provisioned_passphrase()");
    expect(source).toContain("stat -f '%Lp'");
    expect(source).toContain("stat -f '%u'");
    expect(source).toContain("400|600) ;;");
    expect(source).toContain("sed -n '1p'");
    expect(source).toContain("trap 'unset PASSPHRASE' EXIT");
    expect(
      source.indexOf("FRIDAY_CLAUDE_MISSION_PROOF_PREFLIGHT_ONLY=1"),
    ).toBeLessThan(
      source.indexOf('PASSPHRASE="$(read_provisioned_passphrase)"'),
    );
  });
});
