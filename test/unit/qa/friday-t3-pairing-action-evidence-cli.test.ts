import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-t3-pairing-action-evidence.mjs";
const checker = "scripts/ops/check-friday-design-action-runtime-evidence.mjs";

function writeFile(root: string, relative: string, body: string) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

function reconcile(mode: "status-only" | "pair") {
  const afterDevice = mode === "pair" ? "1" : "0";
  return [
    "truth=friday_t3_pairing_proof_no_operator_key_no_grant_no_passport",
    `mode=${mode}`,
    "device_id=ios-pair-proof-1",
    "pairing_id=pair-proof-1",
    "db=/tmp/rust-hub.sqlite",
    "trusted_device_count_before=0",
    `trusted_device_count_after=${afterDevice}`,
    "trust_grant_count_before=7",
    "trust_grant_count_after=7",
    "context_passport_count_before=3",
    "context_passport_count_after=3",
    "client_output=/tmp/client.json",
    "server_log=/tmp/server.log",
    "",
  ].join("\n");
}

function client(mode: "status-only" | "pair", overrides: Record<string, string> = {}) {
  return {
    truth: mode === "pair"
      ? "pairing_pairack_real_sealed_ws_no_grant_no_passport_no_operator_key"
      : "pairing_status_only_no_trusted_device_write",
    hub_id: "friday-hub-test",
    pairing_id: "pair-proof-1",
    device_id: "ios-pair-proof-1",
    device_pubkey_hex: "abc123",
    hub_online: "true",
    capabilities: "pairing,read_seam_enroll",
    ack_accepted: mode === "pair" ? "true" : "",
    ack_error_code: "",
    ...overrides,
  };
}

function contractBody() {
  return `# Friday Action Contract

**This is a wiring contract for the later Rust/native agent, NOT runtime proof.** Every row is design-proof; wired_registry ≠ runtime PASS.

| Surface | Screen [state] | action_id | Label | capability_id | reg | reg_status | truth_status | result/target | Rust/Hub owner gate test expectation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mobile | firstLaunch | firstlaunch_scan | Scan to pair | trust_center_pairing_connected_devices | x | wired | wired_registry | result:scanning | Runtime proof required. |
| mobile | firstLaunch [later] | firstlaunch_pairnow | Pair now | trust_center_pairing_connected_devices | x | wired | wired_registry | result:scanning | Runtime proof required. |
`;
}

describe("friday-t3-pairing-action-evidence", () => {
  it("exports status-only scan evidence without satisfying pair-now", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-t3-pairing-action-"));
    try {
      const reconcilePath = writeFile(root, "db-reconcile.txt", reconcile("status-only"));
      const clientPath = writeFile(root, "client.json", JSON.stringify(client("status-only"), null, 2));
      const outPath = join(root, "action-runtime-evidence.json");
      const stdout = execFileSync("node", [
        script,
        `--reconcile=${reconcilePath}`,
        `--client-output=${clientPath}`,
        `--out=${outPath}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as { status?: string; actionCount?: number };
      expect(result.status).toBe("ready");
      expect(result.actionCount).toBe(1);
      const actionEvidence = JSON.parse(readFileSync(outPath, "utf8")) as { actions?: Array<{ action_id?: string }> };
      expect(actionEvidence.actions?.map((row) => row.action_id)).toEqual(["firstlaunch_scan"]);

      const contract = writeFile(root, "ACTION-CONTRACT.md", contractBody());
      writeFile(root, "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift", "Button(\"Scan to pair\") {} Button(\"Pair now\") {}");
      const check = JSON.parse(execFileSync("node", [
        checker,
        `--repo-root=${root}`,
        `--contract=${contract}`,
        `--runtime-evidence=${outPath}`,
      ], { cwd: process.cwd(), encoding: "utf8" })) as {
        counts?: { missingRuntimeEvidence?: number };
        gaps?: { missingRuntimeEvidence?: Array<{ actionId?: string }> };
      };
      expect(check.counts?.missingRuntimeEvidence).toBe(1);
      expect(check.gaps?.missingRuntimeEvidence).toEqual([
        expect.objectContaining({ actionId: "firstlaunch_pairnow" }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exports scan and pair-now only after a real accepted PairAck DB delta", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-t3-pairing-action-pair-"));
    try {
      const reconcilePath = writeFile(root, "db-reconcile.txt", reconcile("pair"));
      const clientPath = writeFile(root, "client.json", JSON.stringify(client("pair"), null, 2));
      const stdout = execFileSync("node", [
        script,
        `--reconcile=${reconcilePath}`,
        `--client-output=${clientPath}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as {
        status?: string;
        actions?: Array<{ action_id?: string; capability_id?: string }>;
      };
      expect(result.status).toBe("ready");
      expect(result.actions?.map((row) => row.action_id)).toEqual([
        "firstlaunch_scan",
        "firstlaunch_pairnow",
      ]);
      expect(result.actions?.every((row) => row.capability_id === undefined)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when PairAck is rejected or grant state changes", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-t3-pairing-action-bad-"));
    try {
      const badReconcile = reconcile("pair").replace("trust_grant_count_after=7", "trust_grant_count_after=8");
      const reconcilePath = writeFile(root, "db-reconcile.txt", badReconcile);
      const clientPath = writeFile(root, "client.json", JSON.stringify(client("pair", { ack_accepted: "false" }), null, 2));
      const result = spawnSync("node", [
        script,
        `--reconcile=${reconcilePath}`,
        `--client-output=${clientPath}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(output.blockers?.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
        "trust_grant_changed",
        "pairack_not_accepted",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
