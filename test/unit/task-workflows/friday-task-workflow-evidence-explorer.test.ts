import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createFridaySqliteLayer } from "#state";

import { FridayDomainError } from "../../../src/errors/friday-domain-error.js";
import {
  createFridayTaskWorkflowRepository,
  createFridayTaskWorkflowService,
  redactFridayEvidenceRefForDrilldown,
} from "../../../src/task-workflows/index.js";
import type { FridayTaskWorkflowService } from "../../../src/task-workflows/index.js";

let tmpDir: string;
let db: ReturnType<typeof createFridaySqliteLayer>;
let nextId = 0;
let frozenNow = "2026-05-16T00:00:00.000Z";

function makeService(): FridayTaskWorkflowService {
  const repository = createFridayTaskWorkflowRepository();
  return createFridayTaskWorkflowService({
    db,
    repository,
    idGenerator: () => {
      nextId += 1;
      return `id-${nextId.toString(16).padStart(8, "0")}`;
    },
    nowIso: () => frozenNow,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-tw-evidence-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  db = createFridaySqliteLayer({
    dbPath,
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
  nextId = 0;
  frozenNow = "2026-05-16T00:00:00.000Z";
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    // ok
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Phase 13.5D Global Evidence Explorer v1", () => {
  it("indexes evidence refs across workflows with metadata only, no raw refId", () => {
    const service = makeService();
    const workflowA = service.create({
      charter: "explorer test A",
      taskKind: "general",
      contextPackage: {
        allowedFiles: ["src/x.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
    });
    const workflowB = service.create({
      charter: "explorer test B",
      taskKind: "general",
      contextPackage: {
        allowedFiles: ["src/y.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
    });
    const claimA = service.draftClaim(workflowA.id, {
      claimText: "claim a",
      claimKind: "runtime_evidence",
    });
    const claimB = service.draftClaim(workflowB.id, {
      claimText: "claim b",
      claimKind: "code_evidence",
    });
    service.attachEvidenceRef(workflowA.id, claimA.id, {
      refKind: "agent.run",
      refId: "agent-run-a",
      refSource: "agent_run_event",
      refHash: "hash-a",
    });
    service.attachEvidenceRef(workflowB.id, claimB.id, {
      refKind: "workflow.run",
      refId: "workflow-run-b",
      refSource: "workflow_run_evidence",
      refHash: "hash-b",
    });
    const all = service.queryEvidenceExplorer({});
    expect(all).toHaveLength(2);
    for (const entry of all) {
      // Metadata projection MUST NOT include the raw refId field.
      expect((entry as Record<string, unknown>).refId).toBeUndefined();
    }
    // Filter by source.
    const byAgentRun = service.queryEvidenceExplorer({
      refSource: "agent_run_event",
    });
    expect(byAgentRun).toHaveLength(1);
    expect(byAgentRun[0].workflowId).toBe(workflowA.id);
    // Filter by workflow id.
    const byWorkflow = service.queryEvidenceExplorer({
      workflowId: workflowB.id,
    });
    expect(byWorkflow).toHaveLength(1);
    expect(byWorkflow[0].refKind).toBe("workflow.run");
  });

  it("refuses gated drilldown without explicit gateConfirmed=true", () => {
    const service = makeService();
    const workflow = service.create({
      charter: "raw drilldown gate",
      taskKind: "general",
      contextPackage: {
        allowedFiles: ["src/x.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
    });
    const claim = service.draftClaim(workflow.id, {
      claimText: "claim",
      claimKind: "runtime_evidence",
    });
    const { evidenceRef } = service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent.run",
      refId: "agent-run-id",
      refSource: "agent_run_event",
    });
    expect(() =>
      service.getEvidenceRefRawDrilldown(evidenceRef.id, false),
    ).toThrowError(
      expect.objectContaining({
        code: "TASK_WORKFLOW_EVIDENCE_RAW_GATE_REQUIRED",
      }) as unknown as Error,
    );
  });

  it("returns server-redacted refId fields when the gate is confirmed and never exposes the raw refId", () => {
    const service = makeService();
    const workflow = service.create({
      charter: "redaction proof",
      taskKind: "general",
      contextPackage: {
        allowedFiles: ["src/x.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
    });
    const claim = service.draftClaim(workflow.id, {
      claimText: "claim with sensitive payload",
      claimKind: "code_evidence",
    });
    const sensitiveRefId = "log-line:sk-AAAAAAAAAAAAAAAAAAAA token plus extra";
    const { evidenceRef } = service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "log.line",
      refId: sensitiveRefId,
      refSource: "observability_audit",
    });
    const drilldown = service.getEvidenceRefRawDrilldown(evidenceRef.id, true);
    expect(drilldown.evidenceRefId).toBe(evidenceRef.id);
    // The redacted field replaces the secret-pattern with <REDACTED>.
    expect(drilldown.refIdRedacted).toContain("<REDACTED>");
    expect(drilldown.refIdRedacted).not.toMatch(/sk-AAAAAAAAAAAAAAAAAAAA/);
    expect(drilldown.redactionApplied).toBe(true);
    // The drilldown shape must NOT carry the unredacted raw refId field —
    // module_26d requires the gated raw drilldown to surface the
    // server-redacted form only. Serialization of the full payload must
    // not contain the raw sensitive value either.
    expect((drilldown as Record<string, unknown>).refId).toBeUndefined();
    expect("refId" in (drilldown as Record<string, unknown>)).toBe(false);
    const serialized = JSON.stringify(drilldown);
    expect(serialized).not.toContain("sk-AAAAAAAAAAAAAAAAAAAA");
    expect(serialized).not.toContain(sensitiveRefId);
  });

  it("reports redactionApplied=false when no secret patterns are present and still omits raw refId", () => {
    const drilldown = redactFridayEvidenceRefForDrilldown({
      id: "ref-1",
      workflowId: "wf-1",
      claimId: "claim-1",
      refKind: "agent.run",
      refId: "harmless-id-1234",
      refHash: null,
      refSource: "agent_run_event",
      createdAt: "2026-05-16T00:00:00Z",
    });
    expect(drilldown.redactionApplied).toBe(false);
    expect(drilldown.refIdRedacted).toBe("harmless-id-1234");
    // Even when no redaction is applied, the raw refId field must not be
    // present on the drilldown payload.
    expect((drilldown as Record<string, unknown>).refId).toBeUndefined();
    expect("refId" in (drilldown as Record<string, unknown>)).toBe(false);
  });

  it("404s when the evidence ref id is unknown", () => {
    const service = makeService();
    expect(() => service.getEvidenceRefRawDrilldown("unknown", true)).toThrowError(
      expect.objectContaining({
        code: "TASK_WORKFLOW_EVIDENCE_REF_NOT_FOUND",
      }) as unknown as Error,
    );
  });
});
