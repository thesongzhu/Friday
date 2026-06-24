import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-ios-live-write-read-capture.sh";
const missionId = "mission-mobile-live-roundtrip-wrapper";
const workItemId = "work-mobile-live-roundtrip-wrapper";

function fakeSwiftScript(dir: string, proofStatus = "pass") {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "swift");
  writeFileSync(path, `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "test" ] || exit 42
[ -n "\${FRIDAY_MOBILE_LIVE_WRITE_READ_ROUNDTRIP_PROOF_OUT:-}" ] || exit 43
cat >"\${FRIDAY_MOBILE_LIVE_WRITE_READ_ROUNDTRIP_PROOF_OUT}" <<'JSON'
{
  "truth_label": "ios_mobile_live_write_read_roundtrip_proof_not_ui_device_proof",
  "status": "${proofStatus}",
  "generated_at_utc": "2026-06-24T12:00:00Z",
  "mission_id": "${missionId}",
  "work_item_id": "${workItemId}",
  "surface_kind": "mobile",
  "delivery_route": "ios://friday-mobile/live-write-read-roundtrip/wrapper",
  "write": {
    "status": "ready",
    "created_or_ready": true,
    "mission_id": "${missionId}",
    "work_item_id": "${workItemId}",
    "endpoint": { "host": "127.0.0.1", "port": 48750 }
  },
  "read_projection": {
    "mission_id": "${missionId}",
    "work_item_ids": ["${workItemId}"],
    "contains_written_work_item": true,
    "generated_at_ms": 1782290000000,
    "endpoint": { "host": "127.0.0.1", "port": 59151 }
  },
  "caveat": "Mobile live write-read artifact only; not END-BAR, not GO-LIVE, not UI/device proof."
}
JSON
`, { mode: 0o755 });
  return bin;
}

describe("friday-ios-live-write-read-capture", () => {
  it("runs the live proof command, derives mobile events, and writes a capture index", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ios-live-capture-"));
    try {
      const outDir = join(tempDir, "capture");
      const fakeBin = fakeSwiftScript(tempDir);
      const stdout = execFileSync("bash", [script, `--out-dir=${outDir}`, "--read-port=59151"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(stdout).toContain("PASS - mobile live write-read proof");
      const proof = JSON.parse(readFileSync(join(outDir, "ios-live-write-read-proof.json"), "utf8")) as {
        mission_id?: string;
      };
      expect(proof.mission_id).toBe(missionId);

      const events = readFileSync(join(outDir, "ios-live-write-read-events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as Array<{ surface?: string; mission_id?: string }>;
      expect(events).toHaveLength(5);
      expect(new Set(events.map((event) => event.surface))).toEqual(new Set(["mobile"]));
      expect(new Set(events.map((event) => event.mission_id))).toEqual(new Set([missionId]));

      const index = JSON.parse(readFileSync(join(outDir, "capture-index.json"), "utf8")) as {
        status?: string;
        mobile?: { event_count?: number };
        caveat?: string;
      };
      expect(index.status).toBe("ready");
      expect(index.mobile?.event_count).toBe(5);
      expect(index.caveat).toContain("Mobile same-run capture only");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the proof-events driver refuses the artifact", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ios-live-capture-blocked-"));
    try {
      const outDir = join(tempDir, "capture");
      const fakeBin = fakeSwiftScript(tempDir, "blocked");
      const result = spawnSync("bash", [script, `--out-dir=${outDir}`], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).not.toContain("PASS - mobile live write-read proof");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("requires an absolute output directory", () => {
    const result = spawnSync("bash", [script, "--out-dir=relative"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--out-dir must be absolute");
  });
});
