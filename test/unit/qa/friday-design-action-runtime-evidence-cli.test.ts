import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-design-action-runtime-evidence.mjs";

function writeFile(root: string, relative: string, body: string) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

function contractBody() {
  return `# Friday Action Contract — mobile + desktop

**This is a wiring contract for the later Rust/native agent, NOT runtime proof.** Every row is design-proof; wired_registry ≠ runtime PASS.

| Surface | Screen [state] | action_id | Label | capability_id | reg | reg_status | truth_status | result/target | Rust/Hub owner · gate · test expectation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mobile | fridayChat | act | Send to Friday | ask_friday_chat_compose_send | ✓ | wired | wired_registry | result:submitted | Runtime test must prove gate enforcement. |
| desktop | fridayChat | check | Approve | security_approval_bound_principal_gate_cat10_netnew | ✓ | wired | wired_registry | result:confirmed | Runtime test must prove gate enforcement. |
| mobile | voice | disabled | Voice backend unavailable | action_local | · | local | design_proof | result:disabled:reference | Local affordance only. |
`;
}

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "friday-design-action-runtime-"));
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift", "struct FridayChatScreen { Button(\"Send to Friday\") {} }");
  writeFile(root, "apps/friday-ios/Sources/FridayMobileShellCore/FridayChatViewModel.swift", "func send() {}");
  writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopChatScreen.swift", "struct DesktopChatScreen { Button(\"Approve\") {} }");
  writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/OperationsOverviewViewModel.swift", "func approveNeedsMeItem() {}");
  const contract = writeFile(root, "ACTION-CONTRACT.md", contractBody());
  return { root, contract };
}

function sameCapabilityContractBody() {
  return `# Friday Action Contract — mobile + desktop

**This is a wiring contract for the later Rust/native agent, NOT runtime proof.** Every row is design-proof; wired_registry ≠ runtime PASS.

| Surface | Screen [state] | action_id | Label | capability_id | reg | reg_status | truth_status | result/target | Rust/Hub owner · gate · test expectation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mobile | memory | check | Confirm | memory_review_no_silent_write_decide_candidate | ✓ | wired | wired_registry | result:confirmed | Runtime test must prove gate enforcement. |
| mobile | memory | memory_resolve | Keep old | memory_review_no_silent_write_decide_candidate | ✓ | wired | wired_registry | result:confirmed | Runtime test must prove gate enforcement. |
`;
}

function sameActionDifferentCapabilityContractBody() {
  return `# Friday Action Contract — mobile + desktop

**This is a wiring contract for the later Rust/native agent, NOT runtime proof.** Every row is design-proof; wired_registry ≠ runtime PASS.

| Surface | Screen [state] | action_id | Label | capability_id | reg | reg_status | truth_status | result/target | Rust/Hub owner · gate · test expectation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| desktop | fridayChat | check | Approve | security_approval_bound_principal_gate_cat10_netnew | ✓ | wired | wired_registry | result:confirmed | Runtime test must prove gate enforcement. |
| desktop | fridayChat | check | Keep | memory_review_no_silent_write_decide_candidate | ✓ | wired | wired_registry | result:confirmed | Runtime test must prove gate enforcement. |
`;
}

describe("check-friday-design-action-runtime-evidence", () => {
  it("reports design action runtime gaps without counting static Swift hints as proof", () => {
    const { root, contract } = fixtureRepo();
    try {
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--contract=${contract}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        truth?: string;
        status?: string;
        counts?: {
          actionableRows?: number;
          uniqueActionableRows?: number;
          missingRuntimeEvidence?: number;
          missingUniqueRuntimeEvidence?: number;
        };
        gaps?: { missingRuntimeEvidence?: Array<{ actionId?: string }> };
      };
      expect(report.truth).toBe("design_action_runtime_gap_report_not_endbar_not_runtime_adoption");
      expect(report.status).toBe("gaps_present");
      expect(report.counts?.actionableRows).toBe(2);
      expect(report.counts?.uniqueActionableRows).toBe(2);
      expect(report.counts?.missingRuntimeEvidence).toBe(2);
      expect(report.counts?.missingUniqueRuntimeEvidence).toBe(2);
      expect(report.gaps?.missingRuntimeEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionId: "act" }),
          expect.objectContaining({ actionId: "check" }),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts explicit runtime action evidence but still requires real evidence for every actionable row", () => {
    const { root, contract } = fixtureRepo();
    try {
      const runtime = writeFile(root, "action-runtime-evidence.json", JSON.stringify({
        actions: [
          {
            surface: "mobile",
            screen: "fridayChat",
            action_id: "act",
            status: "pass",
            evidence_ref: "proof://mobile/send",
          },
        ],
      }, null, 2));
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--contract=${contract}`,
        `--runtime-evidence=${runtime}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        counts?: { missingRuntimeEvidence?: number; missingUniqueRuntimeEvidence?: number };
        gaps?: { missingRuntimeEvidence?: Array<{ surface?: string; actionId?: string }> };
      };
      expect(report.status).toBe("gaps_present");
      expect(report.counts?.missingRuntimeEvidence).toBe(1);
      expect(report.counts?.missingUniqueRuntimeEvidence).toBe(1);
      expect(report.gaps?.missingRuntimeEvidence).toEqual([
        expect.objectContaining({ surface: "desktop", actionId: "check" }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges multiple runtime action evidence files", () => {
    const { root, contract } = fixtureRepo();
    try {
      const mobileRuntime = writeFile(root, "mobile-action-runtime-evidence.json", JSON.stringify({
        actions: [
          {
            surface: "mobile",
            screen: "fridayChat",
            action_id: "act",
            status: "pass",
            evidence_ref: "proof://mobile/send",
          },
        ],
      }, null, 2));
      const desktopRuntime = writeFile(root, "desktop-action-runtime-evidence.json", JSON.stringify({
        actions: [
          {
            surface: "desktop",
            screen: "fridayChat",
            action_id: "check",
            status: "pass",
            evidence_ref: "proof://desktop/approve",
          },
        ],
      }, null, 2));
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--contract=${contract}`,
        `--runtime-evidence=${mobileRuntime}`,
        `--runtime-evidence=${desktopRuntime}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        runtimeEvidenceInputs?: string[];
        counts?: { runtimeEvidenceRows?: number; missingRuntimeEvidence?: number; missingUniqueRuntimeEvidence?: number };
      };
      expect(report.status).toBe("runtime_actions_covered");
      expect(report.runtimeEvidenceInputs).toEqual([mobileRuntime, desktopRuntime]);
      expect(report.counts?.runtimeEvidenceRows).toBe(2);
      expect(report.counts?.missingRuntimeEvidence).toBe(0);
      expect(report.counts?.missingUniqueRuntimeEvidence).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let one capability row satisfy a different explicit action on the same screen", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-design-action-runtime-same-cap-"));
    try {
      writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayProjectionScreens.swift", "Button(\"Confirm\") {}; Button(\"Keep old\") {}");
      writeFile(root, "apps/friday-ios/Sources/FridayMobileShellCore/HomeViewModel.swift", "func decideMemory() {}");
      const contract = writeFile(root, "ACTION-CONTRACT.md", sameCapabilityContractBody());
      const runtime = writeFile(root, "action-runtime-evidence.json", JSON.stringify({
        actions: [
          {
            surface: "mobile",
            screen: "memory",
            action_id: "check",
            capability_id: "memory_review_no_silent_write_decide_candidate",
            status: "pass",
            evidence_ref: "proof://mobile/memory-confirm",
          },
        ],
      }, null, 2));
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--contract=${contract}`,
        `--runtime-evidence=${runtime}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        counts?: { missingUniqueRuntimeEvidence?: number };
        gaps?: { missingUniqueRuntimeEvidence?: Array<{ actionId?: string }> };
      };
      expect(report.status).toBe("gaps_present");
      expect(report.counts?.missingUniqueRuntimeEvidence).toBe(1);
      expect(report.gaps?.missingUniqueRuntimeEvidence).toEqual([
        expect.objectContaining({ actionId: "memory_resolve" }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let one explicit action satisfy a different capability on the same screen", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-design-action-runtime-same-action-"));
    try {
      writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopChatScreen.swift", "Button(\"Approve\") {}; Button(\"Keep\") {}");
      writeFile(root, "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/OperationsOverviewViewModel.swift", "func approveNeedsMeItem() {}; func decideMemory() {}");
      const contract = writeFile(root, "ACTION-CONTRACT.md", sameActionDifferentCapabilityContractBody());
      const runtime = writeFile(root, "action-runtime-evidence.json", JSON.stringify({
        actions: [
          {
            surface: "desktop",
            screen: "fridayChat",
            action_id: "check",
            capability_id: "security_approval_bound_principal_gate_cat10_netnew",
            status: "pass",
            evidence_ref: "proof://desktop/approval-approve",
          },
        ],
      }, null, 2));
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--contract=${contract}`,
        `--runtime-evidence=${runtime}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        counts?: { missingUniqueRuntimeEvidence?: number };
        gaps?: { missingUniqueRuntimeEvidence?: Array<{ capabilityId?: string }> };
      };
      expect(report.status).toBe("gaps_present");
      expect(report.counts?.missingUniqueRuntimeEvidence).toBe(1);
      expect(report.gaps?.missingUniqueRuntimeEvidence).toEqual([
        expect.objectContaining({ capabilityId: "memory_review_no_silent_write_decide_candidate" }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed in require-complete mode while runtime evidence is incomplete", () => {
    const { root, contract } = fixtureRepo();
    try {
      const result = spawnSync("node", [
        script,
        `--repo-root=${root}`,
        `--contract=${contract}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(2);
      const report = JSON.parse(result.stdout) as { status?: string };
      expect(report.status).toBe("gaps_present");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
