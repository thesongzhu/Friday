import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FRIDAY_FS_WRITE_TARGET_ARG_KEY,
  resolveFilesystemWriteTarget,
  snapshotTarget,
  verifyFsWriteEvidence,
} from "../../../../src/workflows/runtime/friday-workflow-fs-write-verifier.js";
import type { FridayWorkflowNode } from "../../../../src/workflows/model/friday-workflow-graph.types.js";

// Audit C Stage 2A: the filesystem-write verifier upgrades a side-effect node
// to `verified` ONLY on a real, in-scope, non-self-receipt, non-mirror on-disk
// state delta. Every other case (skill lied / no file / unchanged / out of
// scope / self-receipt / evidence-mirror / co-declared send-class) refuses.

const checksum = (content: string): string => createHash("sha256").update(content).digest("hex");

function actionNode(
  config: Record<string, unknown>,
): Pick<FridayWorkflowNode, "type" | "config"> {
  return { type: "action", config } as Pick<FridayWorkflowNode, "type" | "config">;
}

/** A resolveSkill stub returning a skill with the given grants + skillDir. */
function skillResolver(
  grants: Array<{ resource?: string; action: string; selectors?: { pathPrefixes?: string[] } }>,
  skillDir: string,
): (skillId: string) => unknown {
  return () => ({ id: "s", skillDir, manifest: { permissions: { grants } } });
}

describe("audit C Stage 2A — binding-target convention", () => {
  it("the reserved arg key is the documented literal, and is NOT `$`-prefixed (so it is never mistaken for a workflow expression)", () => {
    // The convention: a reserved `node.config.args.__fridayWriteTarget` key whose
    // value is an ABSOLUTE or WORKSPACE-RELATIVE path (never `$`-prefixed) — so it
    // transits the node executor's `resolveArgs` (which evaluates `$`-prefixed
    // strings) UNTOUCHED, with no change to that shared resolver.
    expect(FRIDAY_FS_WRITE_TARGET_ARG_KEY).toBe("__fridayWriteTarget");
    expect(FRIDAY_FS_WRITE_TARGET_ARG_KEY.startsWith("$")).toBe(false);
  });
});

describe("audit C Stage 2A — resolveFilesystemWriteTarget (binding target)", () => {
  const SKILL_DIR = "/tmp/fake-skill-dir";

  it("returns a target for a pure write-class node with the reserved config.args key", () => {
    const node = actionNode({
      skillId: "s",
      args: { [FRIDAY_FS_WRITE_TARGET_ARG_KEY]: "out/report.json" },
    });
    const t = resolveFilesystemWriteTarget(
      node,
      skillResolver(
        [{ resource: "filesystem", action: "read" }, { resource: "filesystem", action: "write", selectors: { pathPrefixes: ["out"] } }],
        SKILL_DIR,
      ),
    );
    expect(t).not.toBeNull();
    expect(t?.declaredTarget).toBe("out/report.json");
    expect(t?.skillDir).toBe(SKILL_DIR);
    expect(t?.writePathPrefixes).toEqual(["out"]);
  });

  it("returns a target from a single concrete manifest pathPrefix when no reserved key", () => {
    const node = actionNode({ skillId: "s" });
    const t = resolveFilesystemWriteTarget(
      node,
      skillResolver(
        [{ resource: "filesystem", action: "write", selectors: { pathPrefixes: ["out/report.json"] } }],
        SKILL_DIR,
      ),
    );
    expect(t?.declaredTarget).toBe("out/report.json");
  });

  it("refuses (null) when the node co-declares a send/connect/capture/execute grant", () => {
    for (const dis of ["send", "connect", "capture", "execute"]) {
      const node = actionNode({ skillId: "s", args: { [FRIDAY_FS_WRITE_TARGET_ARG_KEY]: "out/x.json" } });
      const t = resolveFilesystemWriteTarget(
        node,
        skillResolver(
          [{ resource: "filesystem", action: "write", selectors: { pathPrefixes: ["out"] } }, { action: dis }],
          SKILL_DIR,
        ),
      );
      expect(t).toBeNull();
    }
  });

  it("refuses (null) when the node co-declares a NON-filesystem side-effecting grant (memory.write is UNWITNESSED)", () => {
    // BLOCKER fix (whitelist, not blacklist): `write` is resource-overloaded. A
    // `memory.write` is a separate durable side effect a runtime fs re-read cannot witness,
    // so a `filesystem.write` + `memory.write` node is NOT an fs-write verification candidate
    // — every side-effecting grant must be EXACTLY `filesystem.write`.
    const node = actionNode({ skillId: "s", args: { [FRIDAY_FS_WRITE_TARGET_ARG_KEY]: "out/x.json" } });
    const t = resolveFilesystemWriteTarget(
      node,
      skillResolver(
        [
          { resource: "filesystem", action: "write", selectors: { pathPrefixes: ["out"] } },
          { resource: "memory", action: "write" },
        ],
        SKILL_DIR,
      ),
    );
    expect(t).toBeNull();
  });

  it("still returns a target when co-declared grants are READ-ONLY (read/receive do NOT disqualify)", () => {
    const node = actionNode({ skillId: "s", args: { [FRIDAY_FS_WRITE_TARGET_ARG_KEY]: "out/x.json" } });
    const t = resolveFilesystemWriteTarget(
      node,
      skillResolver(
        [
          { resource: "filesystem", action: "read" },
          { resource: "memory", action: "read" },
          { resource: "network", action: "receive" },
          { resource: "filesystem", action: "write", selectors: { pathPrefixes: ["out"] } },
        ],
        SKILL_DIR,
      ),
    );
    expect(t).not.toBeNull();
  });

  it("is inert (null) for a write node with no binding target (no reserved key, multiple/glob prefixes)", () => {
    const node = actionNode({ skillId: "s" });
    // glob prefix → not concrete; and no reserved key → no binding target.
    const t = resolveFilesystemWriteTarget(
      node,
      skillResolver([{ resource: "filesystem", action: "write", selectors: { pathPrefixes: ["out/*"] } }], SKILL_DIR),
    );
    expect(t).toBeNull();
  });

  it("is null for non-write nodes and non-action nodes", () => {
    expect(
      resolveFilesystemWriteTarget(actionNode({ skillId: "s" }), skillResolver([{ action: "read" }], SKILL_DIR)),
    ).toBeNull();
    expect(
      resolveFilesystemWriteTarget(
        { type: "data", config: {} } as Pick<FridayWorkflowNode, "type" | "config">,
        skillResolver([{ action: "write" }], SKILL_DIR),
      ),
    ).toBeNull();
  });

  it("is null when the skill is unresolvable or has no skillDir", () => {
    expect(resolveFilesystemWriteTarget(actionNode({ skillId: "s" }), () => null)).toBeNull();
    // no skillDir on the resolved skill → cannot anchor scope → null
    const node = actionNode({ skillId: "s", args: { [FRIDAY_FS_WRITE_TARGET_ARG_KEY]: "out/x.json" } });
    const resolver = () => ({ id: "s", manifest: { permissions: { grants: [{ action: "write" }] } } });
    expect(resolveFilesystemWriteTarget(node, resolver)).toBeNull();
  });
});

describe("audit C Stage 2A — snapshotTarget + verifyFsWriteEvidence (real fs delta)", () => {
  let workspaceDir: string;
  let skillDir: string;
  let evidenceRoot: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-verify-ws-"));
    skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-verify-skill-"));
    // The evidence-export mirror lives under the workspace.
    evidenceRoot = path.join(workspaceDir, ".friday", "artifacts", "workflow-evidence");
    fs.mkdirSync(evidenceRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(skillDir, { recursive: true, force: true });
  });

  function target(declaredTarget: string, pathPrefixes: string[]) {
    return { skillId: "s", skillDir, declaredTarget, targetSource: "node-arg" as const, writePathPrefixes: pathPrefixes };
  }

  it("verifies a newly-created in-scope file (real fs delta → verified)", () => {
    const declared = "${workspaceDir}/out/report.json";
    const t = target(declared, ["${workspaceDir}/out"]);
    const snap = snapshotTarget(t, workspaceDir, { computeChecksum: checksum });
    expect(snap.checksum).toBeNull(); // does not exist yet

    // The "skill" actually writes the declared target.
    fs.mkdirSync(path.join(workspaceDir, "out"), { recursive: true });
    fs.writeFileSync(snap.canonicalPath, JSON.stringify({ ok: true }), "utf8");

    const outcome = verifyFsWriteEvidence(
      { target: t, snapshot: snap, evidenceExportRootDir: evidenceRoot, workspaceDir, returnedArtifactUris: [] },
      { computeChecksum: checksum },
    );
    expect(outcome).toEqual({ verified: true });
  });

  it("manifest-prefix bare-relative target anchors on the SKILL dir (matches validateFridayFilesystemScope)", () => {
    // A `manifest-prefix`-sourced bare-relative target resolves against skillDir;
    // the manifest scope is the same bare-relative prefix, so it is in-scope.
    const t = {
      skillId: "s",
      skillDir,
      declaredTarget: "out/report.json",
      targetSource: "manifest-prefix" as const,
      writePathPrefixes: ["out/report.json"],
    };
    const snap = snapshotTarget(t, workspaceDir, { computeChecksum: checksum });
    // Resolves under the SKILL dir, not the workspace (pre-creation the path is
    // not yet canonicalized, so compare the resolved-but-uncanonicalized forms).
    expect(snap.canonicalPath).toBe(path.resolve(skillDir, "out", "report.json"));
    expect(snap.canonicalPath.startsWith(path.resolve(workspaceDir))).toBe(false);
    fs.mkdirSync(path.join(skillDir, "out"), { recursive: true });
    fs.writeFileSync(snap.canonicalPath, "x", "utf8");
    const outcome = verifyFsWriteEvidence(
      { target: t, snapshot: snap, evidenceExportRootDir: evidenceRoot, workspaceDir, returnedArtifactUris: [] },
      { computeChecksum: checksum },
    );
    expect(outcome).toEqual({ verified: true });
  });

  it("verifies a changed-content in-scope file", () => {
    fs.mkdirSync(path.join(workspaceDir, "out"), { recursive: true });
    const abs = path.join(workspaceDir, "out", "report.json");
    fs.writeFileSync(abs, "v1", "utf8");
    const t = target("${workspaceDir}/out/report.json", ["${workspaceDir}/out"]);
    const snap = snapshotTarget(t, workspaceDir, { computeChecksum: checksum });
    expect(snap.checksum).not.toBeNull();
    fs.writeFileSync(abs, "v2-changed", "utf8");
    const outcome = verifyFsWriteEvidence(
      { target: t, snapshot: snap, evidenceExportRootDir: evidenceRoot, workspaceDir, returnedArtifactUris: [] },
      { computeChecksum: checksum },
    );
    expect(outcome).toEqual({ verified: true });
  });

  it("refuses: skill lied / wrote nothing (target missing post-exec) → proof_pending", () => {
    const t = target("${workspaceDir}/out/report.json", ["${workspaceDir}/out"]);
    const snap = snapshotTarget(t, workspaceDir, { computeChecksum: checksum });
    // No file written.
    const outcome = verifyFsWriteEvidence(
      { target: t, snapshot: snap, evidenceExportRootDir: evidenceRoot, workspaceDir, returnedArtifactUris: [] },
      { computeChecksum: checksum },
    );
    expect(outcome.verified).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("target-missing-post-exec");
  });

  it("refuses: target EXISTED but was UNREADABLE at snapshot (no provable content delta) → proof_pending", () => {
    // LOW-nit fix: an existing-but-unreadable file (existed=true, checksum=null) must NOT be
    // treated as newly-created — a mere permission/readability flip is not write evidence.
    fs.mkdirSync(path.join(workspaceDir, "out"), { recursive: true });
    const abs = path.join(workspaceDir, "out", "report.json");
    fs.writeFileSync(abs, "preexisting", "utf8");
    const t = target("${workspaceDir}/out/report.json", ["${workspaceDir}/out"]);
    // Simulate "existed but unreadable at snapshot": existed=true, checksum=null.
    const snap = { canonicalPath: abs, existed: true, checksum: null as string | null };
    const outcome = verifyFsWriteEvidence(
      { target: t, snapshot: snap, evidenceExportRootDir: evidenceRoot, workspaceDir, returnedArtifactUris: [] },
      { computeChecksum: checksum },
    );
    expect(outcome.verified).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("target-existed-unreadable-pre-exec");
  });

  it("refuses: unchanged checksum (file existed, not modified) → proof_pending", () => {
    fs.mkdirSync(path.join(workspaceDir, "out"), { recursive: true });
    const abs = path.join(workspaceDir, "out", "report.json");
    fs.writeFileSync(abs, "same", "utf8");
    const t = target("${workspaceDir}/out/report.json", ["${workspaceDir}/out"]);
    const snap = snapshotTarget(t, workspaceDir, { computeChecksum: checksum });
    // No change.
    const outcome = verifyFsWriteEvidence(
      { target: t, snapshot: snap, evidenceExportRootDir: evidenceRoot, workspaceDir, returnedArtifactUris: [] },
      { computeChecksum: checksum },
    );
    expect((outcome as { reason: string }).reason).toBe("target-unchanged");
  });

  it("refuses: out-of-scope target (outside declared pathPrefixes) → proof_pending", () => {
    const declared = "${workspaceDir}/escape/report.json";
    const t = target(declared, ["${workspaceDir}/out"]); // declared write scope is out/, target is escape/
    const snap = snapshotTarget(t, workspaceDir, { computeChecksum: checksum });
    fs.mkdirSync(path.join(workspaceDir, "escape"), { recursive: true });
    fs.writeFileSync(snap.canonicalPath, "x", "utf8");
    const outcome = verifyFsWriteEvidence(
      { target: t, snapshot: snap, evidenceExportRootDir: evidenceRoot, workspaceDir, returnedArtifactUris: [] },
      { computeChecksum: checksum },
    );
    expect((outcome as { reason: string }).reason).toBe("target-out-of-scope");
  });

  it("refuses: target == a skill-returned artifact URI (self-receipt / circular) → proof_pending", () => {
    fs.mkdirSync(path.join(workspaceDir, "out"), { recursive: true });
    const declared = "${workspaceDir}/out/receipt.json";
    const t = target(declared, ["${workspaceDir}/out"]);
    const snap = snapshotTarget(t, workspaceDir, { computeChecksum: checksum });
    fs.writeFileSync(snap.canonicalPath, "receipt", "utf8");
    const outcome = verifyFsWriteEvidence(
      {
        target: t,
        snapshot: snap,
        evidenceExportRootDir: evidenceRoot,
        workspaceDir,
        // The skill returned the SAME path as its own artifact.
        returnedArtifactUris: [snap.canonicalPath],
      },
      { computeChecksum: checksum },
    );
    expect((outcome as { reason: string }).reason).toBe("target-equals-returned-artifact");
  });

  it("refuses: target == a file:// returned artifact URI (normalized) → proof_pending", () => {
    fs.mkdirSync(path.join(workspaceDir, "out"), { recursive: true });
    const t = target("${workspaceDir}/out/receipt.json", ["${workspaceDir}/out"]);
    const snap = snapshotTarget(t, workspaceDir, { computeChecksum: checksum });
    fs.writeFileSync(snap.canonicalPath, "receipt", "utf8");
    const outcome = verifyFsWriteEvidence(
      {
        target: t,
        snapshot: snap,
        evidenceExportRootDir: evidenceRoot,
        workspaceDir,
        returnedArtifactUris: [`file://${snap.canonicalPath}`],
      },
      { computeChecksum: checksum },
    );
    expect((outcome as { reason: string }).reason).toBe("target-equals-returned-artifact");
  });

  it("refuses: target under the evidence-export root (mirror / circular proof) → proof_pending", () => {
    // Declared target is inside the evidence-export mirror dir. Scope is the
    // mirror dir so the scope check would pass — only the mirror guard refuses.
    const declared = path.join(evidenceRoot, "run-1", "evidence.json");
    const t = target(declared, [evidenceRoot]);
    const snap = snapshotTarget(t, workspaceDir, { computeChecksum: checksum });
    fs.mkdirSync(path.dirname(snap.canonicalPath), { recursive: true });
    fs.writeFileSync(snap.canonicalPath, "mirror", "utf8");
    const outcome = verifyFsWriteEvidence(
      { target: t, snapshot: snap, evidenceExportRootDir: evidenceRoot, workspaceDir, returnedArtifactUris: [] },
      { computeChecksum: checksum },
    );
    expect((outcome as { reason: string }).reason).toBe("target-under-evidence-export-root");
  });

  it("refuses: no declared write scope (fail-closed) → proof_pending", () => {
    const declared = "${workspaceDir}/out/report.json";
    const t = target(declared, []); // no pathPrefixes
    const snap = snapshotTarget(t, workspaceDir, { computeChecksum: checksum });
    fs.mkdirSync(path.join(workspaceDir, "out"), { recursive: true });
    fs.writeFileSync(snap.canonicalPath, "x", "utf8");
    const outcome = verifyFsWriteEvidence(
      { target: t, snapshot: snap, evidenceExportRootDir: evidenceRoot, workspaceDir, returnedArtifactUris: [] },
      { computeChecksum: checksum },
    );
    expect((outcome as { reason: string }).reason).toBe("no-declared-write-scope");
  });
});
