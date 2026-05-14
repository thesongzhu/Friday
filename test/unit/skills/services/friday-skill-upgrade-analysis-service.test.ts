import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { FridaySqliteLayer } from "#state";
import type { SkillManifestV2 } from "#skills";
import { createFridaySkillRepository } from "#skills";
import { createFridayWorkflowRepository } from "#workflows";
import {
  createFridaySkillUpgradeAnalysisService,
  type FridaySkillUpgradeAnalysisService,
} from "../../../../src/skills/services/friday-skill-upgrade-analysis-service.js";
import type { FridayExternalSkillCandidate } from "../../../../src/skills/converter/services/friday-skill-candidate-store.js";
import type { FridayMutatingActionTicket } from "../../../../src/security/friday-mutating-action-gate.js";

import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

const NOW = "2026-05-13T22:00:00.000Z";

function makeManifest(overrides: Partial<SkillManifestV2> = {}): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "skill-1",
    name: "Skill 1",
    description: "Upgrade analysis test fixture",
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "tester" },
    tags: ["test"],
    runtime: {
      kind: "shell",
      entrypoint: "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: { intents: ["do-stuff"], phrases: ["do stuff"], channels: ["*"] },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent", "workflow"],
    },
    requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
    inputs: [
      { key: "query", type: "string", label: "The query", required: true },
    ],
    outputs: [{ key: "result", type: "string", description: "Result" }],
    permissions: { grants: [], promptOn: [] },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
    ...overrides,
  };
}

function writeSkillFiles(dir: string, manifest = makeManifest()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(join(dir, "SKILL.md"), `# ${manifest.name}\n`, "utf8");
  writeFileSync(join(dir, "skill.ui.json"), JSON.stringify({
    schemaVersion: "1.0",
    title: manifest.name,
    sections: [],
    fields: [],
    outputs: [],
    actions: [],
  }, null, 2), "utf8");
  writeFileSync(join(dir, "run.sh"), "#!/usr/bin/env bash\necho '{\"result\":\"ok\"}'\n", {
    encoding: "utf8",
    mode: 0o755,
  });
}

function makeCandidate(filesDir: string, manifest = makeManifest()): FridayExternalSkillCandidate {
  return {
    candidateId: "cand-v2-abc",
    shadowVersionId: "cand-v2-abc",
    skillId: manifest.id,
    version: manifest.version,
    converterId: "native-friday-package",
    detectedFormat: "friday-package",
    sourceProvenance: {
      sourceKind: "uri",
      sourceDigest: "source-digest",
      redactedUri: "file-uri:redacted",
      formatHint: "friday-package",
    },
    canonicalApprovalProof: {
      gateId: "friday_canonical_mutating_action_gate",
      ticketId: "stage-ticket",
      actionDigest: "stage-digest",
      action: "skills.import.stage_candidate",
      surface: "test",
      resource: { type: "external_skill_candidate", id: "candidate" },
      risk: "high",
      approvalId: "stage-approval",
      approvedByPrincipalId: "tester",
      issuedAt: NOW,
      planDigest: "plan-digest",
    },
    candidateDir: join(filesDir, ".."),
    filesDir,
    stagedAt: NOW,
    validation: {
      ok: true,
      issues: [],
      verifiedAt: NOW,
    },
  };
}

function makeTicket(): FridayMutatingActionTicket {
  return {
    ticketId: "ticket-001",
    actionDigest: "action-digest-001",
    action: "skills.upgrade.decide",
    surface: "test",
    resource: { type: "skill_upgrade", id: "skill-1" },
    risk: "high",
    approvedByPrincipalId: "tester",
    issuedAt: NOW,
  };
}

describe("FridaySkillUpgradeAnalysisService", () => {
  let db: FridaySqliteLayer;
  let skillRepo: ReturnType<typeof createFridaySkillRepository>;
  let workflowRepo: ReturnType<typeof createFridayWorkflowRepository>;
  let tmpBase: string;
  let service: FridaySkillUpgradeAnalysisService;

  const v1Manifest = makeManifest({ version: "1.0.0" });
  const v2Manifest = makeManifest({
    version: "2.0.0",
    inputs: [
      { key: "query", type: "string", label: "The query", required: true },
      { key: "format", type: "string", label: "Output format", required: false },
    ],
  });

  beforeEach(() => {
    db = createTestDb();
    skillRepo = createFridaySkillRepository();
    workflowRepo = createFridayWorkflowRepository({ db });
    tmpBase = join(tmpdir(), `upgrade-analysis-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    db.close();
  });

  function installV1(): void {
    db.withWriteTransaction((conn) => {
      skillRepo.upsertSkillFromCatalog(conn, {
        id: "skill-1",
        name: "Skill 1",
        source: "managed",
        origin: "managed",
        latestVersion: "1.0.0",
        status: "installed",
        currentManifest: v1Manifest,
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(conn, "skill-1", "1.0.0", v1Manifest, NOW);
    });
  }

  function setupService(candidateManifest: SkillManifestV2 = v2Manifest): FridaySkillUpgradeAnalysisService {
    const filesDir = join(tmpBase, "candidates", "cand-v2-abc", "files");
    writeSkillFiles(filesDir, candidateManifest);
    const candidate = makeCandidate(filesDir, candidateManifest);

    const svc = createFridaySkillUpgradeAnalysisService({
      db,
      nowIso: () => NOW,
      skillRepo,
      workflowRepo,
      workspaceDir: tmpBase,
      resolveCandidate: (input) =>
        input.candidateId === candidate.candidateId ? candidate : null,
    });
    service = svc;
    return svc;
  }

  function insertWorkflowWithGraph(
    workflowId: string,
    workflowName: string,
    graphJson: string,
  ): void {
    db.withWriteTransaction((conn) => {
      workflowRepo.insertWorkflow(conn, workflowId, {
        slug: workflowName.toLowerCase().replace(/\s+/g, "-"),
        name: workflowName,
        ownerUserId: "test-user",
      }, "etag-1", NOW);
      workflowRepo.insertVersion(
        conn,
        `${workflowId}-v1`,
        workflowId,
        1,
        "checksum-1",
        graphJson,
        "test-user",
        "initial",
        NOW,
      );
      workflowRepo.publishVersion(conn, workflowId, `${workflowId}-v1`, NOW);
      workflowRepo.setPublishedVersion(conn, workflowId, 1, NOW);
    });
  }

  function insertWorkflowWithSkillNode(
    workflowId: string,
    workflowName: string,
    skillId: string,
    inputMapping?: Record<string, unknown>,
  ): void {
    const graphJson = JSON.stringify({
      nodes: [
        { id: "node-1", type: "action", config: { actionType: "skill", skillId, inputMapping } },
      ],
      edges: [],
    });
    insertWorkflowWithGraph(workflowId, workflowName, graphJson);
  }

  // ─── Test: detects duplicate when installed skill exists ───
  it("detects duplicate when installed skill exists with same skillId", () => {
    installV1();
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.isDuplicate).toBe(true);
    expect(analysis.existingVersion).toBe("1.0.0");
    expect(analysis.candidateVersion).toBe("2.0.0");
    expect(analysis.comparisonReport).not.toBeNull();
    expect(analysis.analysisDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  // ─── Test: no duplicate when skill has no installedVersion ───
  it("no duplicate when skill has no installedVersion", () => {
    db.withWriteTransaction((conn) => {
      skillRepo.upsertSkillFromCatalog(conn, {
        id: "skill-1",
        name: "Skill 1",
        source: "managed",
        origin: "managed",
        status: "not_installed",
        nowIso: NOW,
      });
    });
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.isDuplicate).toBe(false);
    expect(analysis.comparisonReport).toBeNull();
  });

  // ─── Test: correct input/output/permission/trigger diffs ───
  it("comparison report shows correct input/output diffs", () => {
    installV1();
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.comparisonReport!.inputs.added).toContain("format");
    expect(analysis.comparisonReport!.inputs.removed).toEqual([]);
  });

  // ─── Test: breaking changes - removed required input ───
  it("flags removed required input as breaking change", () => {
    installV1();
    const breakingV2 = makeManifest({
      version: "2.0.0",
      inputs: [],
    });
    setupService(breakingV2);
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.comparisonReport!.breakingChanges.length).toBeGreaterThan(0);
    expect(analysis.comparisonReport!.breakingChanges[0].kind).toBe("removed_required_input");
  });

  // ─── Test: breaking changes - runtime kind change ───
  it("flags runtime kind change as breaking change", () => {
    installV1();
    const runtimeChangeV2 = makeManifest({
      version: "2.0.0",
      runtime: {
        kind: "node",
        entrypoint: "index.js",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
    });
    setupService(runtimeChangeV2);
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.comparisonReport!.runtime.kindChanged).toBe(true);
    expect(analysis.comparisonReport!.breakingChanges.some((bc) => bc.kind === "runtime_kind_change")).toBe(true);
  });

  // ─── Test: finds affected workflows ───
  it("finds affected workflows from published graphJson", () => {
    installV1();
    insertWorkflowWithSkillNode("wf-1", "Test Workflow", "skill-1");
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.affectedWorkflows.length).toBe(1);
    expect(analysis.affectedWorkflows[0].workflowId).toBe("wf-1");
    expect(analysis.affectedWorkflows[0].nodes.length).toBe(1);
    expect(analysis.affectedWorkflows[0].nodes[0].nodeId).toBe("node-1");
    expect(analysis.affectedWorkflows[0].nodes[0].effectiveSkillRef).toBe("skill-1");
  });

  // ─── Test: empty affected workflows when none reference the skill ───
  it("empty affected workflows when none reference the skill", () => {
    installV1();
    insertWorkflowWithSkillNode("wf-1", "Other Workflow", "other-skill");
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.affectedWorkflows.length).toBe(0);
  });

  // ─── Test: regression proof passes for compatible manifest ───
  it("regression proof passes for compatible manifest", () => {
    installV1();
    insertWorkflowWithSkillNode("wf-1", "Test Workflow", "skill-1");
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.regressionProof.overallVerdict).toBe("pass");
  });

  // ─── Test: regression proof fails when workflow invocation mode missing ───
  it("regression proof fails when workflow invocation mode missing", () => {
    installV1();
    insertWorkflowWithSkillNode("wf-1", "Test Workflow", "skill-1");
    const noWorkflowModeV2 = makeManifest({
      version: "2.0.0",
      invocation: {
        userInvocable: true,
        modelInvocable: true,
        priority: 50,
        modes: ["intent"],
      },
    });
    setupService(noWorkflowModeV2);
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.regressionProof.overallVerdict).toBe("fail");
    expect(analysis.regressionProof.entries[0].failures.length).toBeGreaterThan(0);
  });

  // ─── Test: recommends replace with no breaking changes ───
  it("recommends replace with no breaking changes", () => {
    installV1();
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.recommendation).toBe("replace");
  });

  // ─── Test: recommends review_required with breaking changes + affected workflows ───
  it("recommends review_required with breaking changes and affected workflows", () => {
    installV1();
    insertWorkflowWithSkillNode("wf-1", "Test Workflow", "skill-1");
    const breakingV2 = makeManifest({
      version: "2.0.0",
      inputs: [],
      invocation: {
        userInvocable: true,
        modelInvocable: true,
        priority: 50,
        modes: ["intent"],
      },
    });
    setupService(breakingV2);
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.recommendation).toBe("review_required");
  });

  // ─── Test: applyDecision replace → upgrade_available ───
  it("applyDecision replace calls updateLifecycleStatus to upgrade_available", () => {
    installV1();
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    const record = service.applyDecision({
      skillId: "skill-1",
      candidateId: "cand-v2-abc",
      decision: "replace",
      analysisDigest: analysis.analysisDigest,
      ticket: makeTicket(),
    });

    expect(record.decision).toBe("replace");
    expect(record.analysisDigest).toBe(analysis.analysisDigest);
    expect(record.approvalProof.ticketId).toBe("ticket-001");

    const skill = db.withReadConnection((conn) => skillRepo.getSkillById(conn, "skill-1"));
    expect(skill!.status).toBe("upgrade_available");
  });

  // ─── Test: applyDecision keep → no state change ───
  it("applyDecision keep does not change lifecycle status", () => {
    installV1();
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    const record = service.applyDecision({
      skillId: "skill-1",
      candidateId: "cand-v2-abc",
      decision: "keep",
      analysisDigest: analysis.analysisDigest,
      ticket: makeTicket(),
    });

    expect(record.decision).toBe("keep");
    const skill = db.withReadConnection((conn) => skillRepo.getSkillById(conn, "skill-1"));
    expect(skill!.status).toBe("installed");
  });

  // ─── Test: applyDecision rejects invalid candidateId ───
  it("applyDecision rejects invalid candidateId", () => {
    installV1();
    setupService();

    expect(() =>
      service.applyDecision({
        skillId: "skill-1",
        candidateId: "bogus-candidate",
        decision: "replace",
        analysisDigest: "any-digest",
        ticket: makeTicket(),
      }),
    ).toThrow(/No staged candidate found/);
  });

  // ─── Test: applyDecision rejects stale analysisDigest ───
  it("applyDecision rejects stale/mismatched analysisDigest", () => {
    installV1();
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(() =>
      service.applyDecision({
        skillId: "skill-1",
        candidateId: "cand-v2-abc",
        decision: "replace",
        analysisDigest: "stale-digest-from-previous-analysis",
        ticket: makeTicket(),
      }),
    ).toThrow(/analysis has changed since the approval/);

    const skill = db.withReadConnection((conn) => skillRepo.getSkillById(conn, "skill-1"));
    expect(skill!.status).toBe("installed");
  });

  // ─── Test: rollback pointer captures previous installedVersion ───
  it("rollback pointer captures previous installedVersion", () => {
    installV1();
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.rollbackPointer.available).toBe(true);
    expect(analysis.rollbackPointer.previousVersion).toBe("1.0.0");
    expect(analysis.rollbackPointer.previousManifestDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  // ─── Test: full scenario ───
  it("full scenario: duplicate → compare → decide → regression → rollback", () => {
    installV1();
    insertWorkflowWithSkillNode("wf-1", "Automation Workflow", "skill-1");
    setupService();

    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.isDuplicate).toBe(true);
    expect(analysis.comparisonReport).not.toBeNull();
    expect(analysis.regressionProof.overallVerdict).toBe("pass");
    expect(analysis.recommendation).toBe("replace");
    expect(analysis.rollbackPointer.available).toBe(true);
    expect(analysis.analysisDigest).toMatch(/^[a-f0-9]{64}$/);

    const record = service.applyDecision({
      skillId: "skill-1",
      candidateId: "cand-v2-abc",
      decision: "replace",
      analysisDigest: analysis.analysisDigest,
      ticket: makeTicket(),
    });

    expect(record.decision).toBe("replace");
    expect(record.analysisDigest).toBe(analysis.analysisDigest);
    expect(record.approvalProof.action).toBe("skills.upgrade.decide");
    expect(record.approvalProof.approvedByPrincipalId).toBe("tester");

    const skill = db.withReadConnection((conn) => skillRepo.getSkillById(conn, "skill-1"));
    expect(skill!.status).toBe("upgrade_available");
  });

  // ─── Test: compiled graph with schemaVersion 2.0 and nested graph.nodes ───
  it("detects affected workflows from compiled graph with nested graph.nodes", () => {
    installV1();
    const compiledGraph = JSON.stringify({
      schemaVersion: "2.0",
      workflowId: "wf-compiled",
      workflowVersionId: "wf-compiled-v1",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "cnode-1", type: "action", label: "Run Skill", config: { skillId: "skill-1", inputMapping: { query: "$.trigger.query" } } },
          { id: "cnode-2", type: "trigger", label: "Start", config: { triggerType: "webhook", method: "POST" } },
        ],
        edges: [{ id: "e-1", sourceNodeId: "cnode-2", targetNodeId: "cnode-1" }],
      },
      failurePolicy: { onFailure: "fail_fast" },
      tests: [],
      checksum: "abc123",
    });
    insertWorkflowWithGraph("wf-compiled", "Compiled Workflow", compiledGraph);
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.affectedWorkflows.length).toBe(1);
    expect(analysis.affectedWorkflows[0].workflowId).toBe("wf-compiled");
    expect(analysis.affectedWorkflows[0].nodes[0].nodeId).toBe("cnode-1");
    expect(analysis.affectedWorkflows[0].nodes[0].inputMappingKeys).toEqual(["query"]);
  });

  // ─── Test: top-level nodes graph still works ───
  it("detects affected workflows from top-level nodes graph", () => {
    installV1();
    const topLevelGraph = JSON.stringify({
      nodes: [
        { id: "tnode-1", type: "action", config: { actionType: "skill", skillId: "skill-1" } },
      ],
      edges: [],
    });
    insertWorkflowWithGraph("wf-toplevel", "Top Level Workflow", topLevelGraph);
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.affectedWorkflows.length).toBe(1);
    expect(analysis.affectedWorkflows[0].nodes[0].nodeId).toBe("tnode-1");
  });

  // ─── Test: config.ref is detected as skill reference ───
  it("detects skill reference via config.ref (fallback to skillId)", () => {
    installV1();
    const refGraph = JSON.stringify({
      nodes: [
        { id: "ref-node-1", type: "action", config: { ref: "skill-1", inputMapping: { query: "$.input.q" } } },
      ],
      edges: [],
    });
    insertWorkflowWithGraph("wf-ref", "Ref Workflow", refGraph);
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.affectedWorkflows.length).toBe(1);
    expect(analysis.affectedWorkflows[0].nodes[0].nodeId).toBe("ref-node-1");
    expect(analysis.affectedWorkflows[0].nodes[0].effectiveSkillRef).toBe("skill-1");
    expect(analysis.affectedWorkflows[0].nodes[0].inputMappingKeys).toEqual(["query"]);
  });

  // ─── Test: regression proof passes when all inputMapping keys are covered ───
  it("regression proof passes when all inputMapping keys are covered by candidate manifest", () => {
    installV1();
    insertWorkflowWithSkillNode("wf-mapped", "Mapped Workflow", "skill-1", { query: "$.trigger.q" });
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.regressionProof.overallVerdict).toBe("pass");
    expect(analysis.affectedWorkflows[0].nodes[0].inputMappingKeys).toEqual(["query"]);
  });

  // ─── Test: regression proof fails when mapped input removed from candidate ───
  it("regression proof fails when workflow node maps an input removed from candidate manifest", () => {
    installV1();
    insertWorkflowWithSkillNode("wf-broken", "Broken Mapping Workflow", "skill-1", {
      query: "$.trigger.q",
      obsoleteField: "$.trigger.old",
    });
    setupService();
    const analysis = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis.regressionProof.overallVerdict).toBe("fail");
    expect(analysis.regressionProof.entries[0].failures.some(
      (f) => f.includes("obsoleteField") && f.includes("not present in candidate manifest inputs"),
    )).toBe(true);
  });

  // ─── Test: non-breaking comparison changes flip analysisDigest ───
  it("analysisDigest changes when non-breaking comparison fields change", () => {
    installV1();
    const v2WithGrant = makeManifest({
      version: "2.0.0",
      inputs: [{ key: "query", type: "string", label: "The query", required: true }],
      permissions: { grants: [{ id: "perm-a", resource: "filesystem", action: "read", required: true, reason: "test" }], promptOn: [] },
    });
    const filesDir1 = join(tmpBase, "candidates", "cand-v2-abc", "files");
    writeSkillFiles(filesDir1, v2WithGrant);
    const cand1 = makeCandidate(filesDir1, v2WithGrant);
    const svc1 = createFridaySkillUpgradeAnalysisService({
      db, nowIso: () => NOW, skillRepo, workflowRepo, workspaceDir: tmpBase,
      resolveCandidate: (input) => input.candidateId === cand1.candidateId ? cand1 : null,
    });
    const digest1 = svc1.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" }).analysisDigest;

    const v2WithDifferentGrant = makeManifest({
      version: "2.0.0",
      inputs: [{ key: "query", type: "string", label: "The query", required: true }],
      permissions: { grants: [{ id: "perm-b", resource: "network", action: "connect", required: true, reason: "test" }], promptOn: [] },
    });
    const filesDir2 = join(tmpBase, "candidates2", "cand-v2-abc", "files");
    writeSkillFiles(filesDir2, v2WithDifferentGrant);
    const cand2 = makeCandidate(filesDir2, v2WithDifferentGrant);
    const svc2 = createFridaySkillUpgradeAnalysisService({
      db, nowIso: () => NOW, skillRepo, workflowRepo, workspaceDir: tmpBase,
      resolveCandidate: (input) => input.candidateId === cand2.candidateId ? { ...cand2, filesDir: filesDir2 } : null,
    });
    const digest2 = svc2.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" }).analysisDigest;

    expect(digest1).not.toBe(digest2);
  });

  // ─── Test: same id/version but different candidate content changes analysisDigest ───
  it("analysisDigest changes for same id/version but different candidate manifest content", () => {
    installV1();
    const v2a = makeManifest({
      version: "2.0.0",
      inputs: [{ key: "query", type: "string", label: "The query", required: true }],
    });
    const v2b = makeManifest({
      version: "2.0.0",
      inputs: [
        { key: "query", type: "string", label: "The query", required: true },
        { key: "extra", type: "string", label: "Extra field", required: false },
      ],
    });

    const filesDir1 = join(tmpBase, "cand-same-ver-a", "cand-v2-abc", "files");
    writeSkillFiles(filesDir1, v2a);
    const cand1 = makeCandidate(filesDir1, v2a);
    const svc1 = createFridaySkillUpgradeAnalysisService({
      db, nowIso: () => NOW, skillRepo, workflowRepo, workspaceDir: tmpBase,
      resolveCandidate: (input) => input.candidateId === cand1.candidateId ? cand1 : null,
    });
    const analysis1 = svc1.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    const filesDir2 = join(tmpBase, "cand-same-ver-b", "cand-v2-abc", "files");
    writeSkillFiles(filesDir2, v2b);
    const cand2 = makeCandidate(filesDir2, v2b);
    const svc2 = createFridaySkillUpgradeAnalysisService({
      db, nowIso: () => NOW, skillRepo, workflowRepo, workspaceDir: tmpBase,
      resolveCandidate: (input) => input.candidateId === cand2.candidateId ? { ...cand2, filesDir: filesDir2 } : null,
    });
    const analysis2 = svc2.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" });

    expect(analysis1.candidateVersion).toBe(analysis2.candidateVersion);
    expect(analysis1.analysisDigest).not.toBe(analysis2.analysisDigest);
  });

  // ─── Test: rollback pointer digest changes when previous manifest content changes ───
  it("rollback pointer digest changes when previous installed manifest content changes with same version", () => {
    const v1a = makeManifest({
      version: "1.0.0",
      permissions: { grants: [{ id: "perm-x", resource: "filesystem", action: "read", required: true, reason: "test" }], promptOn: [] },
    });
    db.withWriteTransaction((conn) => {
      skillRepo.upsertSkillFromCatalog(conn, {
        id: "skill-1", name: "Skill 1", source: "managed", origin: "managed",
        latestVersion: "1.0.0", status: "installed", currentManifest: v1a, nowIso: NOW,
      });
      skillRepo.setInstalledVersion(conn, "skill-1", "1.0.0", v1a, NOW);
    });
    setupService();
    const digestA = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" })
      .rollbackPointer.previousManifestDigest;

    const v1b = makeManifest({
      version: "1.0.0",
      permissions: { grants: [{ id: "perm-y", resource: "network", action: "connect", required: true, reason: "test" }], promptOn: [] },
    });
    db.withWriteTransaction((conn) => {
      skillRepo.upsertSkillFromCatalog(conn, {
        id: "skill-1", name: "Skill 1", source: "managed", origin: "managed",
        latestVersion: "1.0.0", status: "installed", currentManifest: v1b, nowIso: NOW,
      });
      skillRepo.setInstalledVersion(conn, "skill-1", "1.0.0", v1b, NOW);
    });
    setupService();
    const digestB = service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" })
      .rollbackPointer.previousManifestDigest;

    expect(digestA).toMatch(/^[a-f0-9]{64}$/);
    expect(digestB).toMatch(/^[a-f0-9]{64}$/);
    expect(digestA).not.toBe(digestB);
  });

  // ─── Test: malformed workflow graph fails closed ───
  it("malformed workflow graph fails closed with thrown error, not silently skipped", () => {
    installV1();
    insertWorkflowWithGraph("wf-bad", "Bad Workflow", "not valid json {{{");
    setupService();

    expect(() =>
      service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" }),
    ).toThrow(/Cannot parse graph/);
  });

  // ─── Test: empty graphJson on workflow version fails closed ───
  it("empty graphJson on workflow version fails closed", () => {
    installV1();
    insertWorkflowWithGraph("wf-empty-graph", "Empty Graph Workflow", "");
    setupService();

    expect(() =>
      service.analyze({ skillId: "skill-1", candidateId: "cand-v2-abc" }),
    ).toThrow(/graphJson is missing/);
  });
});
