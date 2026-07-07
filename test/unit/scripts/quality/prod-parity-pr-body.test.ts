import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, "scripts/quality/check-prod-parity-pr-body.mjs");
const ciPath = join(repoRoot, ".github/workflows/ci.yml");

function runGate(body: string, changedFiles: string[]) {
  const dir = join(tmpdir(), `friday-prod-parity-pr-body-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const eventPath = join(dir, "event.json");
  const changedFilesPath = join(dir, "changed-files.txt");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { body } }), "utf8");
  writeFileSync(changedFilesPath, `${changedFiles.join("\n")}\n`, "utf8");
  const result = spawnSync(process.execPath, [scriptPath, "--event", eventPath, "--changed-files", changedFilesPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe("prod parity PR body gate", () => {
  it("is wired into CI and rejects lockfile/schema PRs without deploy parity declarations", () => {
    const ci = readFileSync(ciPath, "utf8");
    expect(ci).toContain("check-prod-parity-pr-body.mjs");
    expect(ci).toContain("prod-parity-pr-body");

    const lockfileMissing = runGate("Routine dependency update.", ["pnpm-lock.yaml"]);
    expect(lockfileMissing.status).toBe(1);
    expect(lockfileMissing.stderr).toContain("Native module build proof");

    const schemaMissing = runGate("Schema version bump.", ["rust-core/crates/friday-storage/src/schema.rs"]);
    expect(schemaMissing.status).toBe(1);
    expect(schemaMissing.stderr).toContain("Deployment restart required: Rust services");

    const ok = runGate(
      [
        "Native module build proof: npm ci completed and better-sqlite3.node exists.",
        "Deployment restart required: Rust services; restart rust-ws and read-projection before hub.",
      ].join("\n"),
      ["pnpm-lock.yaml", "rust-core/crates/friday-storage/src/schema.rs"],
    );
    expect(ok.status).toBe(0);

    const irrelevant = runGate("Docs only.", ["docs/readme.md"]);
    expect(irrelevant.status).toBe(0);
  });

  it("treats Rust Cargo.lock as a lockfile that requires native module build proof", () => {
    const cargoLockMissing = runGate("Rust dependency update.", ["rust-core/Cargo.lock"]);
    expect(cargoLockMissing.status).toBe(1);
    expect(cargoLockMissing.stderr).toContain("Native module build proof");
  });

  it("rejects placeholder prod-parity declarations", () => {
    const placeholderProof = runGate(
      [
        "Native module build proof: TODO",
        "Deployment restart required: Rust services",
      ].join("\n"),
      ["pnpm-lock.yaml", "rust-core/crates/friday-storage/src/schema.rs"],
    );
    expect(placeholderProof.status).toBe(1);
    expect(placeholderProof.stderr).toContain("Native module build proof");
    expect(placeholderProof.stderr).toContain("Deployment restart required: Rust services");
  });
});
