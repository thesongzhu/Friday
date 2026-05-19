import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildStudioArtifactCapabilityCandidate,
  validateStudioArtifactAsCandidate,
} from "../../../src/studio/friday-studio-artifact-candidate-bridge.js";
import type { FridayStudioImportedPack, FridayStudioRun } from "../../../src/api/model/friday-api-studio.types.js";

function makeIntegrationRun(overrides?: Partial<FridayStudioRun>): FridayStudioRun {
  return {
    id: "run-001",
    productId: "integration_builder",
    status: "completed",
    title: "Integration - Example API",
    createdAt: "2026-05-14T00:00:00.000Z",
    completedAt: "2026-05-14T00:00:01.000Z",
    artifactRoot: "/tmp/test",
    summary: { zh: "集成 pack 已生成，包含 3 个候选操作。", en: "Integration pack generated with 3 candidate operations." },
    inputs: {
      sourceType: "curl",
      source: "curl -X POST https://api.example.com/items -H 'Content-Type: application/json' -d '{\"name\":\"demo\"}'",
      name: "Example API",
    },
    artifacts: [
      { id: "integration_pack", kind: "json", label: { zh: "集成 pack", en: "Integration pack" }, relativePath: "pack.json", mimeType: "application/json", sizeBytes: 500, previewable: true },
      { id: "integration_readme", kind: "markdown", label: { zh: "说明", en: "README" }, relativePath: "README.md", mimeType: "text/markdown", sizeBytes: 200, previewable: true },
    ],
    checks: [
      { id: "source", label: { zh: "来源", en: "Source" }, status: "passed", detail: { zh: "已解析", en: "Parsed" } },
      { id: "permissions", label: { zh: "权限", en: "Permissions" }, status: "warning", detail: { zh: "需配置", en: "Needs config" } },
    ],
    nextActions: [{ zh: "检查 pack.json", en: "Check pack.json" }],
    ...overrides,
  };
}

function makeGuideRun(): FridayStudioRun {
  return makeIntegrationRun({
    productId: "guided_browser_automation",
    title: "Guide - Audit a page",
    summary: { zh: "步骤包已生成", en: "Step pack generated" },
    artifacts: [
      { id: "guide_pack", kind: "json", label: { zh: "步骤包", en: "Step pack" }, relativePath: "pack.json", mimeType: "application/json", sizeBytes: 300, previewable: true },
    ],
    inputs: { goal: "Audit a public page" },
    checks: [],
  });
}

function makeImportedPack(overrides?: Partial<FridayStudioImportedPack>): FridayStudioImportedPack {
  return {
    id: "import-001",
    name: "Imported Integration",
    description: "Imported pack for testing",
    sourceKind: "directory",
    importedAt: "2026-05-14T00:00:00.000Z",
    fileCount: 3,
    rootPath: "/tmp/imports/import-001",
    packJsonPath: "pack.json",
    entryPrompts: ["Test prompt"],
    productIds: ["integration_builder"],
    ...overrides,
  };
}

describe("validateStudioArtifactAsCandidate", () => {
  it("validates a completed integration builder run as a valid candidate", () => {
    const result = validateStudioArtifactAsCandidate({ run: makeIntegrationRun() });

    expect(result.valid).toBe(true);
    expect(result.sourceType).toBe("studio_artifact");
    expect(result.trustTier).toBe("generated");
    expect(result.inferredCapabilities).toEqual(["custom", "skills"]);
    expect(result.permissions).toContain("network.request");
    expect(result.operationCount).toBe(3);
    expect(result.checks.find((c) => c.id === "run_status")?.status).toBe("passed");
    expect(result.checks.find((c) => c.id === "product_type")?.status).toBe("passed");
    expect(result.checks.find((c) => c.id === "pack_json")?.status).toBe("passed");
  });

  it("validates a guided browser automation run", () => {
    const result = validateStudioArtifactAsCandidate({ run: makeGuideRun() });

    expect(result.valid).toBe(true);
    expect(result.inferredCapabilities).toEqual(["custom"]);
  });

  it("rejects a failed run", () => {
    const result = validateStudioArtifactAsCandidate({
      run: makeIntegrationRun({ status: "failed" }),
    });

    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.id === "run_status")?.status).toBe("failed");
  });

  it("rejects a non-registerable product type", () => {
    const result = validateStudioArtifactAsCandidate({
      run: makeIntegrationRun({ productId: "seo_audit" as never }),
    });

    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.id === "product_type")?.status).toBe("failed");
  });

  it("rejects a run with no pack.json artifact", () => {
    const result = validateStudioArtifactAsCandidate({
      run: makeIntegrationRun({ artifacts: [] }),
    });

    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.id === "pack_json")?.status).toBe("failed");
  });

  it("validates an imported pack with integration_builder productId", () => {
    const result = validateStudioArtifactAsCandidate({
      importedPack: makeImportedPack(),
    });

    expect(result.valid).toBe(true);
    expect(result.inferredCapabilities).toEqual(["custom", "skills"]);
  });

  it("rejects an imported pack with no pack.json", () => {
    const result = validateStudioArtifactAsCandidate({
      importedPack: makeImportedPack({ packJsonPath: undefined }),
    });

    expect(result.valid).toBe(false);
  });

  it("rejects an imported pack with unknown product types", () => {
    const result = validateStudioArtifactAsCandidate({
      importedPack: makeImportedPack({ productIds: [] }),
    });

    expect(result.valid).toBe(false);
  });

  it("returns empty when no input is provided", () => {
    const result = validateStudioArtifactAsCandidate({});

    expect(result.valid).toBe(false);
  });

  it("warns about credential patterns in inputs", () => {
    const result = validateStudioArtifactAsCandidate({
      run: makeIntegrationRun({
        inputs: {
          source: "curl -H 'Authorization: Bearer sk-test-1234567890abcdef' https://api.example.com",
        },
      }),
    });

    expect(result.valid).toBe(true);
    expect(result.checks.find((c) => c.id === "credential_safety")?.status).toBe("warning");
  });

  it("derives api_key risk from Integration Builder pack permissions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-studio-bridge-"));
    try {
      fs.writeFileSync(path.join(root, "pack.json"), JSON.stringify({
        schemaVersion: "friday.studio.integration_pack.v1",
        permissions: ["network.request", "secret.read:api_key"],
      }), "utf8");
      const result = validateStudioArtifactAsCandidate({
        run: makeIntegrationRun({ artifactRoot: root }),
      });

      expect(result.valid).toBe(true);
      expect(result.permissions).toContain("secret.read:api_key");
      expect(result.risks).toContain("api_key");
      const candidates = buildStudioArtifactCapabilityCandidate(result, "run-001");
      expect(candidates.every((candidate) => candidate.risks.includes("api_key"))).toBe(true);
      expect(candidates.every((candidate) => candidate.requiresHuman)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildStudioArtifactCapabilityCandidate", () => {
  it("builds capability candidates from a valid validation result", () => {
    const validation = validateStudioArtifactAsCandidate({ run: makeIntegrationRun() });
    const candidates = buildStudioArtifactCapabilityCandidate(validation, "run-001");

    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.capability).toBe("custom");
    expect(candidates[0]?.sourceType).toBe("studio_artifact");
    expect(candidates[0]?.trustTier).toBe("generated");
    expect(candidates[0]?.requiresApproval).toBe(true);
    expect(candidates[1]?.capability).toBe("skills");
  });

  it("returns empty array for an invalid validation", () => {
    const validation = validateStudioArtifactAsCandidate({
      run: makeIntegrationRun({ status: "failed" }),
    });
    const candidates = buildStudioArtifactCapabilityCandidate(validation, "run-001");

    expect(candidates).toHaveLength(0);
  });
});
