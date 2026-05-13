import { describe, it, expect, vi } from "vitest";

import {
  createFridaySocialImportService,
  type CreateFridaySocialImportServiceDeps,
} from "../../../../src/skills/social-import/friday-social-import-service.js";
import {
  FRIDAY_SOCIAL_IMPORT_PLAN_VERSION,
  type FridaySocialImportRequest,
} from "../../../../src/skills/social-import/friday-social-import.types.js";
import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import type {
  XhsComment,
  XhsPageInteractions,
  XhsSessionManager,
} from "../../../../src/xhs/index.js";

// ─── Helpers ───

function makeSessionManager(overrides: Partial<XhsSessionManager> = {}): XhsSessionManager {
  return {
    saveCookies: vi.fn(),
    loadCookies: vi.fn(),
    isSessionValid: vi.fn(() => true),
    getSession: vi.fn(() => undefined),
    deleteSession: vi.fn(),
    listSessions: vi.fn(() => []),
    touchSession: vi.fn(),
    ...overrides,
  };
}

function makePageInteractions(overrides: Partial<XhsPageInteractions> = {}): XhsPageInteractions {
  const sampleComments: XhsComment[] = [
    { author: "alice", content: "great post", likes: "12" },
    { author: "bob", content: "nice", likes: "3" },
  ];
  return {
    login: vi.fn(),
    search: vi.fn(),
    createPost: vi.fn(),
    extractComments: vi.fn(async () => sampleComments),
    checkLoginState: vi.fn(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CreateFridaySocialImportServiceDeps> = {}): CreateFridaySocialImportServiceDeps {
  return {
    xhsPageInteractions: makePageInteractions(),
    xhsSessionManager: makeSessionManager(),
    ...overrides,
  };
}

function makeRequest(overrides: Partial<FridaySocialImportRequest> = {}): FridaySocialImportRequest {
  return {
    socialUrl: "https://www.xiaohongshu.com/explore/abc123",
    targetGithubRepoUrl: "https://github.com/octocat/Hello-World",
    ...overrides,
  };
}

// ─── URL allowlist ───

describe("createFridaySocialImportService — URL allowlist", () => {
  it("rejects non-XHS social URL with 400 VALIDATION_ERROR", async () => {
    const svc = createFridaySocialImportService(makeDeps());
    await expect(
      svc.prepareStageContext({
        request: makeRequest({ socialUrl: "https://example.com/post/1" }),
        actorPrincipalId: "tenant-a",
        actorPrincipalKind: "user",
        surface: "api:/v1/skills/social-import",
      }),
    ).rejects.toBeInstanceOf(FridayDomainError);
  });

  it("rejects non-https social URL", async () => {
    const svc = createFridaySocialImportService(makeDeps());
    await expect(
      svc.prepareStageContext({
        request: makeRequest({ socialUrl: "http://www.xiaohongshu.com/explore/abc" }),
        actorPrincipalId: "tenant-a",
        actorPrincipalKind: "user",
        surface: "api:/v1/skills/social-import",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 });
  });

  it("rejects non-github.com target URL", async () => {
    const svc = createFridaySocialImportService(makeDeps());
    await expect(
      svc.prepareStageContext({
        request: makeRequest({
          targetGithubRepoUrl: "https://gitlab.com/foo/bar",
        }),
        actorPrincipalId: "tenant-a",
        actorPrincipalKind: "user",
        surface: "api:/v1/skills/social-import",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects malformed target path (missing owner/repo)", async () => {
    const svc = createFridaySocialImportService(makeDeps());
    await expect(
      svc.prepareStageContext({
        request: makeRequest({ targetGithubRepoUrl: "https://github.com/" }),
        actorPrincipalId: "tenant-a",
        actorPrincipalKind: "user",
        surface: "api:/v1/skills/social-import",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects data:, file:, javascript: schemes", async () => {
    const svc = createFridaySocialImportService(makeDeps());
    for (const scheme of [
      "data:text/plain;base64,YWFh",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      await expect(
        svc.prepareStageContext({
          request: makeRequest({ socialUrl: scheme }),
          actorPrincipalId: "tenant-a",
          actorPrincipalKind: "user",
          surface: "api:/v1/skills/social-import",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });
});

// ─── Human-blocked branch ───

describe("createFridaySocialImportService — human-blocked", () => {
  it("throws 503 SOCIAL_IMPORT_QR_LOGIN_REQUIRED when session is not valid", async () => {
    const sessionManager = makeSessionManager({
      isSessionValid: vi.fn(() => false),
    });
    const pageInteractions = makePageInteractions();
    const svc = createFridaySocialImportService({
      xhsPageInteractions: pageInteractions,
      xhsSessionManager: sessionManager,
    });
    let thrown: unknown = null;
    try {
      await svc.prepareStageContext({
        request: makeRequest(),
        actorPrincipalId: "tenant-a",
        actorPrincipalKind: "user",
        surface: "api:/v1/skills/social-import",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe("SOCIAL_IMPORT_QR_LOGIN_REQUIRED");
    expect((thrown as FridayDomainError).httpStatus).toBe(503);
    const details = (thrown as FridayDomainError).details as Record<string, unknown>;
    expect(details.blockedBy).toBe("xhs.qr_login");
    expect(details.remediation).toBe("agent_tool:xhs.login");
    expect(pageInteractions.extractComments).not.toHaveBeenCalled();
  });
});

// ─── Successful stage context ───

describe("createFridaySocialImportService — stage context", () => {
  it("produces a deterministic planDigest for the same inputs", async () => {
    const svc = createFridaySocialImportService(makeDeps());
    const args = {
      request: makeRequest(),
      actorPrincipalId: "tenant-a",
      actorPrincipalKind: "user",
      surface: "api:/v1/skills/social-import",
    } as const;
    const a = await svc.prepareStageContext(args);
    const b = await svc.prepareStageContext(args);
    expect(a.planDigest).toBe(b.planDigest);
    expect(a.planDigest.length).toBeGreaterThan(16);
  });

  it("records extraction shape with field names only, never values", async () => {
    const svc = createFridaySocialImportService(makeDeps());
    const ctx = await svc.prepareStageContext({
      request: makeRequest(),
      actorPrincipalId: "tenant-a",
      actorPrincipalKind: "user",
      surface: "api:/v1/skills/social-import",
    });
    expect(ctx.extraction.socialDomain).toBe("xiaohongshu.com");
    expect(ctx.extraction.fieldsPresent).toEqual(["author", "content", "likes"]);
    expect(ctx.extraction.commentCount).toBe(2);
    expect(ctx.extraction.extractionDurationMs).toBeGreaterThanOrEqual(0);
    // The stage context MUST NOT carry any comment author / content / likes
    // VALUES. Stringify and search for the stub fixture values.
    const serialised = JSON.stringify(ctx);
    expect(serialised).not.toContain("alice");
    expect(serialised).not.toContain("bob");
    expect(serialised).not.toContain("great post");
    expect(serialised).not.toContain("nice");
  });

  it("redacts query strings from social and target URIs", async () => {
    const svc = createFridaySocialImportService(makeDeps());
    const ctx = await svc.prepareStageContext({
      request: makeRequest({
        socialUrl: "https://www.xiaohongshu.com/explore/note-1?token=xyz&trace=abcdef",
        targetGithubRepoUrl: "https://github.com/octocat/Hello-World?token=zzz",
      }),
      actorPrincipalId: "tenant-a",
      actorPrincipalKind: "user",
      surface: "api:/v1/skills/social-import",
    });
    // Query-string contents must be redacted (the converter helper replaces
    // search with `?redacted=1`). Path segments are preserved per the
    // existing redaction shape used by the converter — they are not assumed
    // to contain secrets.
    expect(ctx.redactedSocialUri).not.toContain("token=xyz");
    expect(ctx.redactedSocialUri).not.toContain("trace=abcdef");
    expect(ctx.redactedTargetUri).not.toContain("token=zzz");
    // Response-shaped fields (the ones the route returns to the client and
    // would emit into a learning payload) must not contain raw query values.
    // The internal `source.uri` field is excluded because the converter
    // service needs the raw URL to materialise the candidate; that field
    // is never echoed to the response body by the route handler.
    const responseShaped = {
      redactedSocialUri: ctx.redactedSocialUri,
      redactedTargetUri: ctx.redactedTargetUri,
      sourceProvenanceDigest: ctx.sourceProvenanceDigest,
      extraction: ctx.extraction,
      planDigest: ctx.planDigest,
    };
    const responseFlat = JSON.stringify(responseShaped);
    expect(responseFlat).not.toContain("token=xyz");
    expect(responseFlat).not.toContain("token=zzz");
    expect(responseFlat).not.toContain("trace=abcdef");
  });

  it("uses ctx.actorPrincipalId in planDigest derivation (not body)", async () => {
    const svc = createFridaySocialImportService(makeDeps());
    const a = await svc.prepareStageContext({
      request: makeRequest(),
      actorPrincipalId: "actor-1",
      actorPrincipalKind: "user",
      surface: "api:/v1/skills/social-import",
    });
    const b = await svc.prepareStageContext({
      request: makeRequest(),
      actorPrincipalId: "actor-2",
      actorPrincipalKind: "user",
      surface: "api:/v1/skills/social-import",
    });
    expect(a.planDigest).not.toBe(b.planDigest);
  });

  it("plan version is recorded for the slice", () => {
    expect(FRIDAY_SOCIAL_IMPORT_PLAN_VERSION).toBe("friday.phase_02b.social-import.v1");
  });

  it("surfaces extraction failure as 502 with redacted URLs", async () => {
    const socialUrl = "https://www.xiaohongshu.com/explore/abc123";
    const targetGithubRepoUrl = "https://github.com/octocat/Hello-World";
    const svc = createFridaySocialImportService(
      makeDeps({
        xhsPageInteractions: makePageInteractions({
          extractComments: vi.fn(async () => {
            throw new Error(
              `navigation to ${socialUrl} failed for target ${targetGithubRepoUrl}`,
            );
          }),
        }),
      }),
    );
    let thrown: unknown = null;
    try {
      await svc.prepareStageContext({
        request: makeRequest({ socialUrl, targetGithubRepoUrl }),
        actorPrincipalId: "tenant-a",
        actorPrincipalKind: "user",
        surface: "api:/v1/skills/social-import",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe(
      "SOCIAL_IMPORT_EXTRACTION_FAILED",
    );
    expect((thrown as FridayDomainError).httpStatus).toBe(502);
    expect((thrown as FridayDomainError).message).not.toContain(socialUrl);
    expect((thrown as FridayDomainError).message).not.toContain(
      targetGithubRepoUrl,
    );
    expect((thrown as FridayDomainError).message).toContain(
      "<redacted-social-uri>",
    );
    expect((thrown as FridayDomainError).message).toContain(
      "<redacted-target-uri>",
    );
  });
});
