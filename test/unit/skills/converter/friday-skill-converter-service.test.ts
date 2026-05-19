import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFridaySkillConverterService } from "#skills/converter";
import { createFridaySkillConverterRegistry } from "#skills/converter";
import { createFridaySkillImportInstaller } from "#skills/converter";
import { createFridaySkillPackageArchiver } from "#skills/converter";
import { createClawdbotSkillMdConverter } from "#skills/converter";
import { createNativeSkillPackageConverter } from "#skills/converter";
import { createFridayN8nNodeConverter } from "#skills/converter";
import { createFridayOpenAiGptActionConverter } from "#skills/converter";
import { createFridayCodeRepoConverter } from "#skills/converter";
import { createFridayDiscoveryIntegrationConverter } from "#skills/converter";
import { createFridayUndocumentedApiConverter } from "#skills/converter";
import { createFridayRecordingConverter } from "#skills/converter";
import { createFridaySkillStageMutatingActionRequest } from "#skills/converter";
import type {
  FridaySkillConversionSource,
  FridaySkillCandidateEvent,
  FridaySkillConverterContext,
  FridaySkillConverter,
  FridaySkillConverterRegistry,
  FridaySkillImportInput,
  FridaySkillImportedEvent,
  FridaySkillSourceFormat,
} from "#skills/converter";
import type { SkillManifestV2 } from "#skills";
import { createFridaySkillCandidateStore } from "../../../../src/skills/converter/services/friday-skill-candidate-store.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayMutatingActionTicket,
} from "../../../../src/security/friday-mutating-action-gate.js";

const NOW_ISO = "2026-02-17T12:00:00.000Z";
const STAGE_ACTOR = {
  kind: "test",
  id: "test-runner",
  principalId: "test-runner",
};

function makeCanonicalStageTicket(input: {
  source: FridaySkillConversionSource;
  formatHint?: FridaySkillSourceFormat | "auto";
  target?: FridaySkillImportInput["target"];
  replace?: boolean;
  refreshRegistry?: boolean;
  options?: FridaySkillImportInput["options"];
  idempotencyKey?: string;
}): FridayMutatingActionTicket {
  const gate = createFridayMutatingActionGate({
    nowIso: () => NOW_ISO,
    ticketIdGenerator: () => "ticket-1",
  });
  const request = createFridaySkillStageMutatingActionRequest({
    source: input.source,
    formatHint: input.formatHint,
    target: input.target,
    replace: input.replace,
    refreshRegistry: input.refreshRegistry,
    options: input.options,
    actor: STAGE_ACTOR,
    surface: "test:skill-import",
    idempotencyKey: input.idempotencyKey ?? "test-stage-1",
  });
  const result = gate.evaluate({
    ...request,
    canonicalApproval: {
      decision: "approved",
      approvalId: "approval-1",
      decidedByPrincipalId: STAGE_ACTOR.principalId,
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt: "2026-02-17T13:00:00.000Z",
    },
  });
  if (!result.ticket) {
    throw new Error(`failed to create canonical test ticket: ${result.reason}`);
  }
  return result.ticket;
}

function withCanonicalStageTicket<T extends FridaySkillImportInput>(input: T): T {
  return {
    ...input,
    canonicalApprovalTicket: makeCanonicalStageTicket(input),
  };
}

function makeValidManifest(overrides: Partial<SkillManifestV2> = {}): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "service-test-skill",
    name: "Service Test Skill",
    description: "Test skill for service tests",
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "Test" },
    tags: ["test"],
    runtime: {
      kind: "shell",
      entrypoint: "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: { intents: [], phrases: [], channels: ["*"] },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent"],
    },
    requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
    inputs: [],
    outputs: [{ key: "result", type: "string" }],
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

describe("FridaySkillConverterService", () => {
  let testDir: string;
  let managedDir: string;
  let workspaceDir: string;
  let ctx: FridaySkillConverterContext;

  beforeEach(() => {
    testDir = join(tmpdir(), `friday-test-service-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    managedDir = join(testDir, "managed");
    workspaceDir = join(testDir, "workspace");
    mkdirSync(managedDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    ctx = {
      workspaceDir,
      managedSkillsDir: managedDir,
      nowIso: () => NOW_ISO,
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function createService(options: {
    onRegistryRefresh?: () => Promise<void>;
    onSkillImported?: (event: FridaySkillImportedEvent) => Promise<void> | void;
    onSkillCandidateStaged?: (event: FridaySkillCandidateEvent) => Promise<void> | void;
  } = {}) {
    const registry = createFridaySkillConverterRegistry();
    registry.register(createNativeSkillPackageConverter());
    registry.register(createClawdbotSkillMdConverter());
    registry.register(createFridayN8nNodeConverter());
    registry.register(createFridayOpenAiGptActionConverter());
    registry.register(createFridayCodeRepoConverter());
    registry.register(createFridayDiscoveryIntegrationConverter());
    registry.register(createFridayUndocumentedApiConverter());
    registry.register(createFridayRecordingConverter());

    const installer = createFridaySkillImportInstaller();
    const archiver = createFridaySkillPackageArchiver();

    return createFridaySkillConverterService({
      registry,
      installer,
      archiver,
      context: ctx,
      onSkillImported: options.onSkillImported,
      onSkillCandidateStaged: options.onSkillCandidateStaged,
      onRegistryRefresh: options.onRegistryRefresh,
    });
  }

  // ─── listConverters ───

  describe("listConverters", () => {
    it("returns all registered converters", () => {
      const service = createService();
      const converters = service.listConverters();

      expect(converters.length).toBe(8);

      const ids = converters.map((c) => c.id);
      expect(ids).toContain("native-friday-package");
      expect(ids).toContain("discovery-integration");
      expect(ids).toContain("clawdbot-skill-md");
      expect(ids).toContain("n8n-node");
      expect(ids).toContain("openai-gpt-action");
      expect(ids).toContain("code-repo");
      expect(ids).toContain("undocumented-api");
      expect(ids).toContain("desktop-recording");

      // Each should have source formats
      for (const converter of converters) {
        expect(converter.sourceFormats.length).toBeGreaterThan(0);
        expect(converter.displayName).toBeTruthy();
      }
      expect(converters.find((c) => c.id === "discovery-integration")?.sourceFormats)
        .toEqual(["friday-package"]);
    });
  });

  // ─── detect ───

  describe("detect", () => {
    it("detects native Friday package", async () => {
      const skillDir = join(testDir, "native-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(makeValidManifest()));

      const service = createService();
      const detection = await service.detect({ uri: skillDir });

      expect(detection).not.toBeNull();
      expect(detection!.format).toBe("friday-package");
      expect(detection!.converterId).toBe("native-friday-package");
    });

    it("detects Clawdbot SKILL.md", async () => {
      const skillDir = join(testDir, "clawdbot-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "SKILL.md"), `---
name: test
---

A test skill.
`);

      const service = createService();
      const detection = await service.detect({ uri: skillDir });

      expect(detection).not.toBeNull();
      expect(detection!.format).toBe("clawdbot-skill-md");
    });

    it("detects n8n node", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify({
        name: "testNode",
        displayName: "Test Node",
        properties: [],
      }));

      const service = createService();
      const detection = await service.detect({ uri: filePath });

      expect(detection).not.toBeNull();
      expect(detection!.format).toBe("n8n-node");
    });

    it("detects OpenAPI spec", async () => {
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Test API", version: "1.0" },
        paths: { "/test": { get: { operationId: "test" } } },
      }));

      const service = createService();
      const detection = await service.detect({ uri: filePath });

      expect(detection).not.toBeNull();
      expect(detection!.format).toBe("openai-gpt-action");
    });

    it("returns null for unrecognized source", async () => {
      const filePath = join(testDir, "unknown.txt");
      writeFileSync(filePath, "not a skill source");

      const service = createService();
      const detection = await service.detect({ uri: filePath });

      expect(detection).toBeNull();
    });
  });

  // ─── convert ───

  describe("convert", () => {
    it("converts a Clawdbot SKILL.md", async () => {
      const skillDir = join(testDir, "clawdbot-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "SKILL.md"), `---
name: weather
---

Get weather.

\`\`\`bash
curl wttr.in
\`\`\`
`);

      const service = createService();
      const result = await service.convert({
        source: { uri: skillDir },
      });

      expect(result.converterId).toBe("clawdbot-skill-md");
      expect(result.drafts).toHaveLength(1);
      expect(result.validation).toHaveLength(1);
      expect(result.validation[0]!.skillId).toBeTruthy();
      expect(result.quality).toBeDefined();
      expect(result.quality!.score).toBeGreaterThanOrEqual(0);
      expect(result.quality!.score).toBeLessThanOrEqual(100);
    });

    it("throws when no converter matches", async () => {
      const filePath = join(testDir, "unknown.txt");
      writeFileSync(filePath, "unknown content");

      const service = createService();
      await expect(service.convert({ source: { uri: filePath } })).rejects.toThrow(
        "No converter detected",
      );
    });

    it("validates converted drafts", async () => {
      const skillDir = join(testDir, "validate-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "SKILL.md"), `---
name: valid-skill
---

A valid skill.

\`\`\`bash
echo hello
\`\`\`
`);

      const service = createService();
      const result = await service.convert({
        source: { uri: skillDir },
      });

      expect(result.validation).toHaveLength(1);
      // Validation should have run
      expect(Array.isArray(result.validation[0]!.issues)).toBe(true);
    });

    it("keeps validation temp roots independent from untrusted manifest IDs", async () => {
      const outsidePrefix = `friday-validate-outside-${Date.now()}`;
      const maliciousId = `../../${outsidePrefix}`;
      const source = { contentBase64: Buffer.from("malicious draft", "utf8").toString("base64") };
      const manifest = makeValidManifest({ id: maliciousId });
      const uiSchema = {
        schemaVersion: "1.0" as const,
        title: "Malicious Draft",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      };
      const fakeConverter: FridaySkillConverter = {
        id: "malicious-draft-converter",
        displayName: "Malicious Draft Converter",
        priority: 100,
        detect: vi.fn(async () => ({
          converterId: "malicious-draft-converter",
          format: "friday-package",
          confidence: 1,
          reasons: ["test"],
        })),
        convert: vi.fn(async () => ({
          converterId: "malicious-draft-converter",
          detectedFormat: "friday-package",
          drafts: [
            {
              manifest,
              uiSchema,
              files: [
                {
                  path: "skill.manifest.json",
                  content: JSON.stringify(manifest, null, 2),
                },
                {
                  path: "skill.ui.json",
                  content: JSON.stringify(uiSchema, null, 2),
                },
                {
                  path: "run.sh",
                  content: "#!/usr/bin/env bash\necho '{}'\n",
                  executable: true,
                },
              ],
              warnings: [],
              conversionReport: {
                sourceFormat: "friday-package",
                convertedAt: NOW_ISO,
                converterId: "malicious-draft-converter",
              },
            },
          ],
        })),
      };
      const registry: FridaySkillConverterRegistry = {
        register: vi.fn(),
        list: () => [fakeConverter],
        detect: vi.fn(async () => ({
          converterId: fakeConverter.id,
          format: "friday-package",
          confidence: 1,
          reasons: ["test"],
        })),
        getConverter: vi.fn(() => fakeConverter),
      };
      const service = createFridaySkillConverterService({
        registry,
        installer: createFridaySkillImportInstaller(),
        archiver: createFridaySkillPackageArchiver(),
        context: ctx,
      });
      const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith(outsidePrefix));

      const result = await service.convert({ source });

      const after = readdirSync(tmpdir()).filter((entry) => entry.startsWith(outsidePrefix));
      expect(result.validation).toHaveLength(1);
      expect(after).toEqual(before);
      expect(existsSync(join(workspaceDir, "skill-candidates"))).toBe(false);
    });

    it("keeps conversion preview-only even when dryRun is omitted", async () => {
      const stagedMock = vi.fn().mockResolvedValue(undefined);
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const skillDir = join(testDir, "candidate-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(makeValidManifest({
        id: "candidate-skill",
      }), null, 2));
      writeFileSync(join(skillDir, "skill.ui.json"), JSON.stringify({
        schemaVersion: "1.0",
        title: "Candidate Skill",
        sections: [],
        fields: [],
        outputs: [],
        actions: [{ id: "run", label: "Run", style: "primary" }],
      }));
      writeFileSync(join(skillDir, "run.sh"), "#!/usr/bin/env bash\necho '{\"ok\":true}'\n");

      const service = createService({
        onSkillCandidateStaged: stagedMock,
        onRegistryRefresh: refreshMock,
      });
      const result = await service.convert({
        source: { uri: skillDir },
        formatHint: "friday-package",
      });

      expect(result.drafts).toHaveLength(1);
      expect(result.validation[0]?.ok).toBe(true);
      expect("candidates" in result).toBe(false);
      expect(existsSync(join(managedDir, "candidate-skill", "run.sh"))).toBe(false);
      expect(stagedMock).not.toHaveBeenCalled();
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it("keeps dry-run conversion as preview only with no persisted candidate", async () => {
      const stagedMock = vi.fn().mockResolvedValue(undefined);
      const skillDir = join(testDir, "dry-run-candidate-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(makeValidManifest({
        id: "dry-run-candidate-skill",
      }), null, 2));
      writeFileSync(join(skillDir, "skill.ui.json"), JSON.stringify({
        schemaVersion: "1.0",
        title: "Dry Run Candidate Skill",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      }));
      writeFileSync(join(skillDir, "run.sh"), "#!/usr/bin/env bash\necho '{}'\n");

      const service = createService({ onSkillCandidateStaged: stagedMock });
      const result = await service.convert({
        source: { uri: skillDir },
        formatHint: "friday-package",
        dryRun: true,
      });

      expect("candidates" in result).toBe(false);
      expect(stagedMock).not.toHaveBeenCalled();
    });

  });

  // ─── staged candidate import ───

  describe("import", () => {
    it("stages a persisted candidate without installing it", async () => {
      const skillDir = join(testDir, "import-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(makeValidManifest({
        id: "import-skill",
      }), null, 2));
      writeFileSync(join(skillDir, "skill.ui.json"), JSON.stringify({
        schemaVersion: "1.0",
        title: "Import Skill",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      }));
      writeFileSync(join(skillDir, "run.sh"), "#!/usr/bin/env bash\necho '{\"ok\":true}'\n");
      const stagedMock = vi.fn().mockResolvedValue(undefined);
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const service = createService({
        onSkillCandidateStaged: stagedMock,
        onRegistryRefresh: refreshMock,
      });

      const result = await service.import(withCanonicalStageTicket({
        source: { uri: skillDir },
        target: "managed",
      }));
      expect(result.candidates).toHaveLength(1);
      const candidate = result.candidates[0]!;
      expect(candidate.skillId).toBe("import-skill");
      expect(candidate.validation.ok).toBe(true);
      expect(candidate.canonicalApprovalProof).toMatchObject({
        gateId: "friday_canonical_mutating_action_gate",
        ticketId: "ticket-1",
        action: "skills.import.stage_candidate",
        approvalId: "approval-1",
      });
      expect(result.registryRefreshed).toBe(false);
      expect(existsSync(join(candidate.filesDir, "run.sh"))).toBe(true);
      expect(existsSync(join(managedDir, "import-skill", "run.sh"))).toBe(false);
      expect(service.getCandidate({
        skillId: "import-skill",
        candidateId: candidate.candidateId,
      })?.candidateId).toBe(candidate.candidateId);
      expect(stagedMock).toHaveBeenCalledWith(expect.objectContaining({
        candidate: expect.objectContaining({ candidateId: candidate.candidateId }),
      }));
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it("does not notify legacy import hooks or install during candidate staging", async () => {
      const skillDir = join(testDir, "dry-run-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(makeValidManifest({
        id: "dry-run-skill",
      }), null, 2));
      writeFileSync(join(skillDir, "skill.ui.json"), JSON.stringify({
        schemaVersion: "1.0",
        title: "Dry Run Skill",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      }));
      writeFileSync(join(skillDir, "run.sh"), "#!/usr/bin/env bash\necho '{}'\n");

      const importedMock = vi.fn().mockResolvedValue(undefined);
      const service = createService({ onSkillImported: importedMock });

      const result = await service.import(withCanonicalStageTicket({
        source: { uri: skillDir },
        dryRun: true,
      }));
      expect(result.candidates).toHaveLength(1);
      expect(existsSync(join(managedDir, "dry-run-skill", "run.sh"))).toBe(false);
      expect(importedMock).not.toHaveBeenCalled();
    });

    it("persists only redacted source provenance for staged external candidates", async () => {
      const sourceUri = "https://example.com/skill-repo?token=candidate-secret-token&api_key=secret";
      const manifest = makeValidManifest({
        id: "redacted-source-candidate",
      });
      const uiSchema = {
        schemaVersion: "1.0" as const,
        title: "Redacted Source Candidate",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      };
      const store = createFridaySkillCandidateStore({
        context: ctx,
        installer: createFridaySkillImportInstaller(),
        hubVersion: "1.0.0",
        supportedApiVersions: ["1"],
      });

      const candidate = await store.stage({
        source: { uri: sourceUri, formatHint: "friday-package" },
        converterId: "native-friday-package",
        detectedFormat: "friday-package",
        draft: {
          manifest,
          uiSchema,
          files: [
            {
              path: "skill.manifest.json",
              content: JSON.stringify(manifest, null, 2),
            },
            {
              path: "skill.ui.json",
              content: JSON.stringify(uiSchema),
            },
            {
              path: "run.sh",
              content: "#!/usr/bin/env bash\necho '{}'\n",
              executable: true,
            },
            {
              path: "conversion.report.json",
              content: JSON.stringify({
                sourceFormat: "friday-package",
                sourceRef: sourceUri,
                convertedAt: NOW_ISO,
                converterId: "native-friday-package",
              }, null, 2),
            },
          ],
          warnings: [],
          conversionReport: {
            sourceFormat: "friday-package",
            sourceRef: sourceUri,
            convertedAt: NOW_ISO,
            converterId: "native-friday-package",
          },
        },
        validation: { ok: true, issues: [] },
        canonicalApprovalTicket: makeCanonicalStageTicket({
          source: { uri: sourceUri, formatHint: "friday-package" },
        }),
      });

      const persisted = readFileSync(join(candidate.candidateDir, "candidate.json"), "utf8");
      const report = readFileSync(join(candidate.filesDir, "conversion.report.json"), "utf8");
      const serializedCandidate = JSON.stringify(candidate);
      expect(candidate.sourceProvenance).toMatchObject({
        sourceKind: "uri",
        redactedUri: "https://example.com/skill-repo?redacted=1",
        formatHint: "friday-package",
      });
      expect(serializedCandidate).not.toContain(sourceUri);
      expect(serializedCandidate).not.toContain("candidate-secret-token");
      expect(serializedCandidate).not.toContain("\"source\":");
      expect(candidate.canonicalApprovalProof).toMatchObject({
        gateId: "friday_canonical_mutating_action_gate",
        ticketId: "ticket-1",
        action: "skills.import.stage_candidate",
        approvalId: "approval-1",
      });
      expect(persisted).not.toContain(sourceUri);
      expect(persisted).not.toContain("candidate-secret-token");
      expect(persisted).not.toContain("api_key");
      expect(persisted).toContain("sourceProvenance");
      expect(persisted).toContain("canonicalApprovalProof");
      expect(report).not.toContain(sourceUri);
      expect(report).not.toContain("candidate-secret-token");
      expect(report).toContain("https://example.com/skill-repo?redacted=1");
    });

    it("does not corrupt draft files when source query values are short", async () => {
      const sourceUri = "https://example.com/skill-repo?token=x&view=a";
      const manifest = makeValidManifest({
        id: "short-query-candidate",
      });
      const uiSchema = {
        schemaVersion: "1.0" as const,
        title: "Short Query Candidate",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      };
      const store = createFridaySkillCandidateStore({
        context: ctx,
        installer: createFridaySkillImportInstaller(),
        hubVersion: "1.0.0",
        supportedApiVersions: ["1"],
      });

      const candidate = await store.stage({
        source: { uri: sourceUri, formatHint: "friday-package" },
        converterId: "native-friday-package",
        detectedFormat: "friday-package",
        draft: {
          manifest,
          uiSchema,
          files: [
            {
              path: "skill.manifest.json",
              content: JSON.stringify(manifest, null, 2),
            },
            {
              path: "skill.ui.json",
              content: JSON.stringify(uiSchema),
            },
            {
              path: "run.sh",
              content: "#!/usr/bin/env bash\necho alpha beta gamma\n",
              executable: true,
            },
            {
              path: "conversion.report.json",
              content: JSON.stringify({
                sourceFormat: "friday-package",
                sourceRef: sourceUri,
                convertedAt: NOW_ISO,
                converterId: "native-friday-package",
              }, null, 2),
            },
          ],
          warnings: [],
          conversionReport: {
            sourceFormat: "friday-package",
            sourceRef: sourceUri,
            convertedAt: NOW_ISO,
            converterId: "native-friday-package",
          },
        },
        validation: { ok: true, issues: [] },
        canonicalApprovalTicket: makeCanonicalStageTicket({
          source: { uri: sourceUri, formatHint: "friday-package" },
        }),
      });

      const script = readFileSync(join(candidate.filesDir, "run.sh"), "utf8");
      const report = readFileSync(join(candidate.filesDir, "conversion.report.json"), "utf8");
      expect(script).toContain("alpha beta gamma");
      expect(script).not.toContain("redacted");
      expect(report).not.toContain(sourceUri);
      expect(report).toContain("https://example.com/skill-repo?redacted=1");
    });

    it("persists only a digest for contentBase64 staged candidate sources", async () => {
      const rawContent = "secret inline skill payload";
      const contentBase64 = Buffer.from(rawContent, "utf8").toString("base64");
      const manifest = makeValidManifest({
        id: "redacted-content-candidate",
      });
      const uiSchema = {
        schemaVersion: "1.0" as const,
        title: "Redacted Content Candidate",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      };
      const store = createFridaySkillCandidateStore({
        context: ctx,
        installer: createFridaySkillImportInstaller(),
        hubVersion: "1.0.0",
        supportedApiVersions: ["1"],
      });

      const candidate = await store.stage({
        source: { contentBase64, formatHint: "openai-gpt-action" },
        converterId: "openai-gpt-action",
        detectedFormat: "openai-gpt-action",
        draft: {
          manifest,
          uiSchema,
          files: [
            {
              path: "skill.manifest.json",
              content: JSON.stringify(manifest, null, 2),
            },
            {
              path: "skill.ui.json",
              content: JSON.stringify(uiSchema),
            },
            {
              path: "run.sh",
              content: "#!/usr/bin/env bash\necho '{}'\n",
              executable: true,
            },
            {
              path: "conversion.report.json",
              content: JSON.stringify({
                sourceFormat: "openai-gpt-action",
                sourceRef: contentBase64,
                convertedAt: NOW_ISO,
                converterId: "openai-gpt-action",
              }, null, 2),
            },
          ],
          warnings: [],
          conversionReport: {
            sourceFormat: "openai-gpt-action",
            sourceRef: contentBase64,
            convertedAt: NOW_ISO,
            converterId: "openai-gpt-action",
          },
        },
        validation: { ok: true, issues: [] },
        canonicalApprovalTicket: makeCanonicalStageTicket({
          source: { contentBase64, formatHint: "openai-gpt-action" },
        }),
      });

      const persisted = readFileSync(join(candidate.candidateDir, "candidate.json"), "utf8");
      const report = readFileSync(join(candidate.filesDir, "conversion.report.json"), "utf8");
      const serializedCandidate = JSON.stringify(candidate);
      expect(candidate.sourceProvenance).toMatchObject({
        sourceKind: "contentBase64",
        formatHint: "openai-gpt-action",
      });
      expect(candidate.sourceProvenance.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.sourceProvenance.redactedUri).toBeUndefined();
      expect(serializedCandidate).not.toContain(contentBase64);
      expect(serializedCandidate).not.toContain(rawContent);
      expect(serializedCandidate).toContain("canonicalApprovalProof");
      expect(persisted).not.toContain(contentBase64);
      expect(persisted).not.toContain(rawContent);
      expect(persisted).toContain("sourceDigest");
      expect(persisted).toContain("canonicalApprovalProof");
      expect(report).not.toContain(contentBase64);
      expect(report).not.toContain(rawContent);
      expect(report).toContain(candidate.sourceProvenance.sourceDigest);
    });

    it("fails closed when no converter matches the source", async () => {
      const filePath = join(testDir, "unknown.txt");
      writeFileSync(filePath, "unknown content");

      const service = createService();
      await expect(service.import(withCanonicalStageTicket({ source: { uri: filePath } }))).rejects.toThrow("No converter detected");
    });

    it("fails closed before candidate writes when canonical proof is missing", async () => {
      const filePath = join(testDir, "unknown.txt");
      writeFileSync(filePath, "unknown content");

      const service = createService();
      await expect(service.import({ source: { uri: filePath } })).rejects.toThrow("canonical approval ticket");
    });
  });

  // ─── pack ───

  describe("pack", () => {
    it("packs a valid skill directory", async () => {
      const skillDir = join(testDir, "pack-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(makeValidManifest({
        id: "pack-test",
      }), null, 2));
      writeFileSync(join(skillDir, "skill.ui.json"), JSON.stringify({
        schemaVersion: "1.0",
        title: "Pack Test",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      }));
      writeFileSync(join(skillDir, "run.sh"), "#!/bin/bash\necho hello");

      const outputFile = join(testDir, "output", "pack-test-1.0.0.friday.tgz");
      const service = createService();

      const result = await service.pack({ skillDir, outputFile });

      expect(result.packageFile).toBe(outputFile);
      expect(result.checksumSha256).toBeTruthy();
    });

    it("throws for non-existent skill directory", async () => {
      const service = createService();
      await expect(service.pack({
        skillDir: "/nonexistent/skill",
        outputFile: join(testDir, "output.friday.tgz"),
      })).rejects.toThrow("Failed to load skill package");
    });
  });
});
