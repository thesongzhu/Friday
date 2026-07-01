import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const wrapper = "scripts/ops/friday-mobile-approval-approve-proof.sh";
const checker = "scripts/ops/check-friday-design-action-runtime-evidence.mjs";

function writeFile(root: string, relative: string, body: string) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

function contractBody() {
  return `# Friday Action Contract

**This is a wiring contract for the later Rust/native agent, NOT runtime proof.** Every row is design-proof; wired_registry ≠ runtime PASS.

| Surface | Screen [state] | action_id | Label | capability_id | reg | reg_status | truth_status | result/target | Rust/Hub owner gate test expectation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mobile | approval | check | Approve with proof | security_approval_bound_principal_gate_cat10_netnew | x | wired | wired_registry | result:confirmed | Runtime proof required. |
| mobile | fridayChat | check | Approve | security_approval_bound_principal_gate_cat10_netnew | x | wired | wired_registry | result:confirmed | Runtime proof required. |
`;
}

describe("friday-mobile-approval-approve-proof", () => {
  it("fails closed unless explicitly live-enabled", () => {
    const result = spawnSync("bash", [wrapper], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        FRIDAY_MOBILE_APPROVAL_APPROVE_LIVE: "0",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("FRIDAY_MOBILE_APPROVAL_APPROVE_LIVE=1");
  });

  it("converts a Swift approve proof into mobile approval action evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-mobile-approval-approve-"));
    try {
      const swiftProof = join(root, "mobile-approval-approve-proof.json");
      const signedApproval = writeFile(root, "signed-approval.json", "{\"signed\":true}\n");
      const fakeSwift = writeFile(root, "swift", `#!/usr/bin/env bash
cat > "${swiftProof}" <<'JSON'
{
  "truth_label": "ios_mobile_live_approval_approve_write_client_proof_signed_artifact_relay_not_sim_tap_not_endbar",
  "status": "pass",
  "run_id": "run-paused-1",
  "approval_id": "approval-1",
  "ui_actions": [
    {
      "surface": "mobile",
      "screen": "fridayChat",
      "action_id": "check",
      "capability_id": "security_approval_bound_principal_gate_cat10_netnew",
      "status": "pass",
      "evidence_ref": "proof://mobile/fridaychat-approval-approve/run-paused-1"
    },
    {
      "surface": "mobile",
      "screen": "approval",
      "action_id": "check",
      "capability_id": "security_approval_bound_principal_gate_cat10_netnew",
      "status": "pass",
      "evidence_ref": "proof://mobile/approval-approve/run-paused-1"
    }
  ]
}
JSON
exit 0
`);
      chmodSync(fakeSwift, 0o755);
      const out = join(root, "action-runtime-evidence.json");

      const stdout = execFileSync("bash", [
        wrapper,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_MOBILE_APPROVAL_APPROVE_LIVE: "1",
          FRIDAY_MOBILE_APPROVAL_APPROVE_STEP: "approve",
          FRIDAY_MOBILE_APPROVAL_APPROVE_RUN_ID: "run-paused-1",
          FRIDAY_MOBILE_APPROVAL_APPROVE_APPROVAL_ID: "approval-1",
          FRIDAY_MOBILE_APPROVAL_APPROVE_SIGNED_APPROVAL: signedApproval,
          FRIDAY_MOBILE_APPROVAL_APPROVE_SWIFT_PROOF_OUT: swiftProof,
          FRIDAY_MOBILE_APPROVAL_APPROVE_ACTION_RUNTIME_OUT: out,
          PATH: `${root}:${process.env.PATH ?? ""}`,
        },
      });

      expect(stdout).toContain("Action runtime evidence:");
      const actionEvidence = JSON.parse(readFileSync(out, "utf8")) as {
        actions?: Array<{ surface?: string; screen?: string; action_id?: string; status?: string }>;
      };
      expect(actionEvidence.actions).toEqual([
        expect.objectContaining({
          surface: "mobile",
          screen: "fridayChat",
          action_id: "check",
          status: "pass",
        }),
        expect.objectContaining({
          surface: "mobile",
          screen: "approval",
          action_id: "check",
          status: "pass",
        }),
      ]);

      const contract = writeFile(root, "ACTION-CONTRACT.md", contractBody());
      writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift", "Button(\"Approve with proof\") {}");
      writeFile(root, "apps/friday-ios/Sources/FridayMobileShellCore/FridayChatViewModel.swift", "func approve() {}");
      const report = JSON.parse(execFileSync("node", [
        checker,
        `--repo-root=${root}`,
        `--contract=${contract}`,
        `--runtime-evidence=${out}`,
      ], { cwd: process.cwd(), encoding: "utf8" })) as {
        counts?: { missingRuntimeEvidence?: number };
        gaps?: { missingRuntimeEvidence?: Array<{ actionId?: string }> };
      };

      expect(report.counts?.missingRuntimeEvidence).toBe(0);
      expect(report.gaps?.missingRuntimeEvidence).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
