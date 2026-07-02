import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
const organicLauncher = resolve(
  repoRoot,
  "scripts/ops/friday-claude-organic-spawn.sh",
);
const organicKeychainWrapper = resolve(
  repoRoot,
  "scripts/ops/friday-claude-organic-spawn-keychain.sh",
);

describe("Claude mission proof operator gate", () => {
  it("keeps the script shell-parseable", () => {
    for (const script of [
      proofScript,
      keychainWrapper,
      organicLauncher,
      organicKeychainWrapper,
    ]) {
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
    expect(source).toContain("FRIDAY_CLAUDE_MISSION_PROOF_RUN_KIND");
    expect(source).toContain("FRIDAY_CLAUDE_MISSION_PROOF_SURFACE_KIND");
    expect(source).toContain("FRIDAY_CLAUDE_MISSION_PROOF_DELIVERY_ROUTE");
    expect(source).toContain(
      'readonly BODY_REF_PREFIX="friday://body/ops/claude-mission-proof-of-life"',
    );
    expect(source).toContain(
      'readonly BODY_REF="${FRIDAY_CLAUDE_MISSION_PROOF_BODY_REF:-${BODY_REF_PREFIX}/${WORK_ITEM_ID}}"',
    );
    expect(source).not.toContain(
      'readonly BODY_REF="${FRIDAY_CLAUDE_MISSION_PROOF_BODY_REF:-friday://body/ops/claude-mission-proof-of-life}"',
    );
    expect(source).toContain('readonly CLAUDE_MODEL="claude-opus-4-8"');
    expect(source).toContain('lane: "claude"');
    expect(source).toContain('targetProviderOrAgent: "claude"');
    expect(source).toContain('proofRequirements: ["outcome:AnswerProduced:>=1"]');
    expect(source).toContain(
      "FRIDAY_CLAUDE_MISSION_PROOF_DELIVERY_ROUTE:-ops://claude-mission-proof-of-life",
    );
    expect(source).toContain("deliveryRoute: $delivery_route");
    expect(source).toContain("intent: $intent");
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
    expect(source).toContain("surface.surface_kind = '${SURFACE_KIND}'");
    expect(source).toContain("surface.delivery_route = '${DELIVERY_ROUTE}'");
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

  it("exposes a Claude organic launcher without the fixed proof prompt", () => {
    const launcherSource = readFileSync(organicLauncher, "utf8");
    const keychainSource = readFileSync(organicKeychainWrapper, "utf8");

    expect(launcherSource).toContain(
      'FRIDAY_CLAUDE_MISSION_PROOF_RUN_KIND="organic"',
    );
    expect(launcherSource).toContain(
      'FRIDAY_CLAUDE_MISSION_PROOF_SURFACE_KIND="${FRIDAY_CLAUDE_ORGANIC_SURFACE_KIND:-desktop}"',
    );
    expect(launcherSource).toContain(
      'FRIDAY_CLAUDE_MISSION_PROOF_DELIVERY_ROUTE="ops://claude-organic-spawn"',
    );
    expect(launcherSource).toContain(
      'FRIDAY_CLAUDE_MISSION_PROOF_INTENT="${TASK_TEXT}"',
    );
    expect(launcherSource).toContain("FRIDAY_OG9_OPERATOR_ORIGIN_ACK");
    expect(launcherSource).toContain("operator-physical-hand-starts-og9-organic-run");
    expect(launcherSource).toContain("agent automation must use proof/soak wrappers instead");
    expect(launcherSource).toContain("observe-wrapper.claude.organic");
    expect(launcherSource).toContain("FRIDAY_CLAUDE_ORGANIC_TASK");
    expect(launcherSource).not.toContain("FRIDAY_CLAUDE_PROOF_OK");

    expect(keychainSource).toContain(
      'FRIDAY_CLAUDE_MISSION_PROOF_PASSPHRASE_STDIN=1 "${ORGANIC_SCRIPT}"',
    );
    expect(keychainSource).not.toContain("FRIDAY_OG9_OPERATOR_ORIGIN_ACK=");
    expect(keychainSource).toContain("passphrase_file_ok()");
    expect(keychainSource).toContain("read_provisioned_passphrase()");
    expect(keychainSource).toContain("stat -f '%Lp'");
    expect(keychainSource).toContain("stat -f '%u'");
    expect(keychainSource).toContain("400|600) ;;");
  });

  it("refuses Claude organic launch without operator-origin acknowledgement", () => {
    const result = spawnSync(organicLauncher, ["operator task"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FRIDAY_OG9_OPERATOR_ORIGIN_ACK: "",
      },
    });

    expect(result.status).toBe(4);
    expect(result.stderr).toContain("strict OG9 organic launch requires FRIDAY_OG9_OPERATOR_ORIGIN_ACK");
    expect(result.stderr).toContain("agent automation must use proof/soak wrappers instead");
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
        'check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_MISSION_AUTO_DISPATCH" "1"',
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

  it("uses one keychain lookup before streaming the passphrase to proof", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "friday-claude-keychain-"));
    try {
      const binDir = join(tempRoot, "bin");
      const fakeSecurityCount = join(tempRoot, "security-count");
      const wrapperPath = join(
        tempRoot,
        "friday-claude-mission-proof-of-life-keychain.sh",
      );
      const fakeProofPath = join(
        tempRoot,
        "friday-claude-mission-proof-of-life.sh",
      );
      const fakeSecurityPath = join(binDir, "security");

      mkdirSync(binDir);
      writeFileSync(wrapperPath, readFileSync(keychainWrapper, "utf8"));
      chmodSync(wrapperPath, 0o700);
      writeFileSync(
        fakeProofPath,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${FRIDAY_CLAUDE_MISSION_PROOF_PREFLIGHT_ONLY:-0}" = "1" ]; then
  echo "preflight-ok"
  exit 0
fi
if [ "\${FRIDAY_CLAUDE_MISSION_PROOF_PASSPHRASE_STDIN:-0}" != "1" ]; then
  echo "missing stdin mode" >&2
  exit 12
fi
IFS= read -r passphrase
printf 'proof-passphrase=%s\\n' "\${passphrase}"
`,
      );
      chmodSync(fakeProofPath, 0o700);
      writeFileSync(
        fakeSecurityPath,
        `#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "\${FRIDAY_FAKE_SECURITY_COUNT}" ]; then
  count="$(cat "\${FRIDAY_FAKE_SECURITY_COUNT}")"
fi
count=$((count + 1))
printf '%s\\n' "\${count}" > "\${FRIDAY_FAKE_SECURITY_COUNT}"
printf 'keychain-passphrase\\n'
`,
      );
      chmodSync(fakeSecurityPath, 0o700);

      const result = spawnSync(wrapperPath, {
        cwd: tempRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_CLAUDE_MISSION_PROOF_PASSPHRASE_FILE: join(
            tempRoot,
            "missing-passphrase",
          ),
          FRIDAY_FAKE_SECURITY_COUNT: fakeSecurityCount,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("preflight-ok");
      expect(result.stdout).toContain("proof-passphrase=keychain-passphrase");
      expect(readFileSync(fakeSecurityCount, "utf8").trim()).toBe("1");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
