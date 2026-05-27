import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createFridayLinkCacheRepository,
  createFridayLinkUnderstandingService,
} from "#link-understanding";
import {
  buildFridayLinkToSkillCandidateSource,
  createFridayLinkToSkillService,
} from "#skills";
import {
  createFridayLinkEvidenceSkillConverter,
  createFridaySkillConverterRegistry,
  createFridaySkillConverterService,
  createFridaySkillImportInstaller,
  createFridaySkillPackageArchiver,
  createFridaySkillStageMutatingActionRequest,
} from "#skills/converter";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
} from "../../../../src/security/friday-mutating-action-gate.js";

const NOW = "2026-05-27T07:12:00.000Z";
const APPROVAL_TEST_KEY = "link-to-skill-test-key";
const PLAN_DIGEST = "link-to-skill-plan-digest";
const ACTOR: FridayMutatingActionActor = {
  kind: "user",
  id: "link-user",
  principalId: "link-user",
};

function makeTempDir(): string {
  const dir = join(tmpdir(), `friday-link-to-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConverterService(root: string) {
  const registry = createFridaySkillConverterRegistry();
  registry.register(createFridayLinkEvidenceSkillConverter());
  return createFridaySkillConverterService({
    registry,
    installer: createFridaySkillImportInstaller(),
    archiver: createFridaySkillPackageArchiver(),
    context: {
      workspaceDir: root,
      managedSkillsDir: join(root, "managed-skills"),
      nowIso: () => NOW,
    },
  });
}

function signStageApproval(input: {
  source: ReturnType<typeof buildFridayLinkToSkillCandidateSource>["source"];
  idempotencyKey: string;
}): FridayCanonicalApprovalResolution {
  const request = createFridaySkillStageMutatingActionRequest({
    source: input.source,
    formatHint: "auto",
    actor: ACTOR,
    surface: "test:link-to-skill",
    idempotencyKey: input.idempotencyKey,
    planDigest: PLAN_DIGEST,
  });
  return signFridayCanonicalApproval({
    decision: "approved",
    approvalId: `approval-${input.idempotencyKey}`,
    decidedByPrincipalId: "link-user",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-27T08:12:00.000Z",
  }, APPROVAL_TEST_KEY);
}

describe("Friday link-to-skill service", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts link evidence, generates a redacted skill candidate source, and stages it through the converter service", async () => {
    const root = makeTempDir();
    tempDirs.push(root);
    const linkUrl = "https://example.com/skill-guide?token=super-secret-link-token";
    const fetchFn = vi.fn(async () => ({
      statusCode: 200,
      contentType: "text/html",
      body: `
        <html>
          <head><title>Invoice Skill Guide</title></head>
          <body>
            <main>
              <h1>Invoice Skill Guide</h1>
              <p>Build a Friday skill that summarizes invoice status for the workspace.</p>
              <p>The deterministic proof phrase is LINK_SKILL_EVIDENCE_READY and the skill must not fetch the source URL when it runs.</p>
              <p>This extra body text gives Readability enough article content to produce stable evidence from the HTML fixture.</p>
            </main>
          </body>
        </html>
      `,
    }));
    const linkUnderstanding = createFridayLinkUnderstandingService({
      fetchFn,
      cache: createFridayLinkCacheRepository(() => NOW),
      nowIso: () => NOW,
    });
    const converterService = makeConverterService(root);
    const gate = createFridayMutatingActionGate({
      nowIso: () => NOW,
      ticketIdGenerator: () => "ticket-link-to-skill",
      approvalSignatureSecret: APPROVAL_TEST_KEY,
      requireApprovalSignature: true,
    });

    const text = `Please turn this into a skill: ${linkUrl}`;
    const evidence = (await linkUnderstanding.processText(text))[0]!;
    expect(evidence.summary).toContain("LINK_SKILL_EVIDENCE_READY");
    const built = buildFridayLinkToSkillCandidateSource({
      evidence,
      skillId: "invoice-link-skill",
      skillName: "Invoice Link Skill",
    });
    expect(JSON.stringify(built.payload)).not.toContain("super-secret-link-token");
    expect(built.payload.redactedUrl).toBe("https://example.com/skill-guide?redacted=1");

    const service = createFridayLinkToSkillService({
      linkUnderstanding,
      converterService,
      canonicalMutationGate: gate,
    });
    const result = await service.stageFromText({
      text,
      actor: ACTOR,
      surface: "test:link-to-skill",
      idempotencyKey: "stage-link-skill",
      planDigest: PLAN_DIGEST,
      canonicalApproval: signStageApproval({
        source: built.source,
        idempotencyKey: "stage-link-skill",
      }),
      skillId: "invoice-link-skill",
      skillName: "Invoice Link Skill",
    });

    expect(result.importResult.converterId).toBe("link-evidence-skill");
    expect(result.importResult.candidates).toHaveLength(1);
    expect(result.importResult.validation[0]?.ok).toBe(true);
    const candidate = result.importResult.candidates[0]!;
    expect(candidate.skillId).toBe("invoice-link-skill");
    expect(candidate.validation.ok).toBe(true);
    expect(candidate.sourceProvenance.sourceKind).toBe("contentBase64");
    expect(existsSync(join(candidate.filesDir, "run.sh"))).toBe(true);
    const runSh = readFileSync(join(candidate.filesDir, "run.sh"), "utf8");
    expect(runSh).toContain("LINK_SKILL_EVIDENCE_READY");
    expect(runSh).toContain("link_evidence_ready");
    expect(runSh).toContain("https://example.com/skill-guide?redacted=1");
    expect(runSh).not.toContain("super-secret-link-token");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("requires canonical approval before writing a generated link skill candidate", async () => {
    const root = makeTempDir();
    tempDirs.push(root);
    const linkUnderstanding = {
      processText: vi.fn(async () => [{
        url: "https://example.com/approved-link-skill",
        title: "Approval Required",
        summary: "LINK_SKILL_APPROVAL_REQUIRED evidence.",
        contentType: "text/html",
        cached: false,
        processingMs: 1,
      }]),
    };
    const service = createFridayLinkToSkillService({
      linkUnderstanding,
      converterService: makeConverterService(root),
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => NOW,
        ticketIdGenerator: () => "ticket-denied",
        approvalSignatureSecret: APPROVAL_TEST_KEY,
        requireApprovalSignature: true,
      }),
    });

    await expect(service.stageFromText({
      text: "https://example.com/approved-link-skill",
      actor: ACTOR,
      surface: "test:link-to-skill",
      idempotencyKey: "missing-approval",
      planDigest: PLAN_DIGEST,
      skillId: "approval-required-link-skill",
    })).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });
  });

  it("blocks private/local URLs before candidate generation", async () => {
    const root = makeTempDir();
    tempDirs.push(root);
    const linkUnderstanding = {
      processText: vi.fn(async () => [{
        url: "http://127.0.0.1:3000/private-skill?token=private-token",
        title: "Private Skill",
        summary: "This must not become a generated skill candidate.",
        contentType: "text/html",
        cached: false,
        processingMs: 1,
      }]),
    };
    const converterService = makeConverterService(root);
    const importSpy = vi.spyOn(converterService, "import");
    const service = createFridayLinkToSkillService({
      linkUnderstanding,
      converterService,
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => NOW,
        ticketIdGenerator: () => "ticket-private",
        approvalSignatureSecret: APPROVAL_TEST_KEY,
        requireApprovalSignature: true,
      }),
    });

    await expect(service.stageFromText({
      text: "http://127.0.0.1:3000/private-skill?token=private-token",
      actor: ACTOR,
      surface: "test:link-to-skill",
      idempotencyKey: "private-url",
      planDigest: PLAN_DIGEST,
      skillId: "private-link-skill",
    })).rejects.toMatchObject({ code: "LINK_TO_SKILL_URL_BLOCKED" });
    expect(importSpy).not.toHaveBeenCalled();
  });
});
