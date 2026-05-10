import { describe, expect, it } from "vitest";
import { validateFridayDeepLink } from "../../../src/deeplink/friday-deeplink-validator.js";
import type { FridayDeepLinkPayload } from "../../../src/deeplink/friday-deeplink-types.js";

function makePayload(overrides: Partial<FridayDeepLinkPayload>): FridayDeepLinkPayload {
  return {
    version: 1,
    type: "provider-template",
    label: "Test",
    ...overrides,
  };
}

describe("validateFridayDeepLink", () => {
  describe("provider-template", () => {
    it("blocks when providerTemplate data is missing", () => {
      const result = validateFridayDeepLink(makePayload({ type: "provider-template" }));
      expect(result.verdict).toBe("blocked");
      expect(result.checks.some((c) => c.level === "blocking" && c.id === "provider-fields")).toBe(true);
    });

    it("blocks when providerKind is empty", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "provider-template",
        providerTemplate: { providerKind: "" },
      }));
      expect(result.verdict).toBe("blocked");
    });

    it("passes with valid provider template", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "provider-template",
        providerTemplate: { providerKind: "openai", apiKey: "$KEY" },
      }));
      expect(result.verdict).toBe("ready");
      expect(result.permissionSummary).toContain("Provider API key will be previewed only and redacted.");
      expect(result.permissionSummary).toContain("Provider template preview does not create, update, enable, or validate a provider.");
      expect(result.permissionSummary).toContain("Provider setup must use the provider lifecycle with explicit validation and promotion before availability.");
      expect(result.payload.providerTemplate?.apiKey).toBe("[redacted]");
    });

    it("redacts plaintext provider api keys from the preview payload", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "provider-template",
        providerTemplate: { providerKind: "openai", apiKey: "sk-live-secret-value" }, // pragma: allowlist secret
      }));

      expect(result.payload.providerTemplate?.apiKey).toBe("[redacted]");
    });

    it("warns on private base URL", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "provider-template",
        providerTemplate: { providerKind: "openai", baseUrl: "http://192.168.1.1:8080" },
      }));
      expect(result.verdict).toBe("needs_review");
      expect(result.checks.some((c) => c.level === "warning" && c.id === "provider-url")).toBe(true);
    });
  });

  describe("skill-source", () => {
    it("blocks when URL is missing", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "skill-source",
        skillSource: { url: "" },
      }));
      expect(result.verdict).toBe("blocked");
    });

    it("passes with valid GitHub URL", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "skill-source",
        skillSource: { url: "https://github.com/user/repo" },
      }));
      expect(result.verdict).toBe("ready");
      expect(result.permissionSummary).toContain("Will stage an external skill candidate for review.");
      expect(result.permissionSummary).toContain("Skill will not be installed or made available until lifecycle validation, approval, and promotion complete.");
    });

    it("redacts token-bearing skill source URLs from preview payloads", () => {
      const rawUrl = "https://example.com/skill-repo?token=deeplink-preview-secret-token";
      const result = validateFridayDeepLink(makePayload({
        type: "skill-source",
        skillSource: { url: rawUrl },
      }));

      expect(result.payload.skillSource?.url).not.toBe(rawUrl);
      expect(result.payload.skillSource?.url).not.toContain("deeplink-preview-secret-token");
      expect(result.payload.skillSource?.url).toBe("https://example.com/skill-repo?redacted=1");
    });

    it("redacts token-bearing skill source URLs from preview payloads", () => {
      const rawUrl = "https://example.com/skill-repo?token=deeplink-preview-secret-token";
      const result = validateFridayDeepLink(makePayload({
        type: "skill-source",
        skillSource: { url: rawUrl },
      }));

      expect(result.payload.skillSource?.url).not.toBe(rawUrl);
      expect(result.payload.skillSource?.url).not.toContain("deeplink-preview-secret-token");
      expect(result.payload.skillSource?.url).toBe("https://example.com/skill-repo?redacted=1");
    });

    it("warns on private URL", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "skill-source",
        skillSource: { url: "http://localhost:3000/skill" },
      }));
      expect(result.verdict).toBe("needs_review");
    });
  });

  describe("mcp-server", () => {
    it("blocks when name is missing", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "mcp-server",
        mcpServer: { name: "", transport: "stdio", command: "npx" },
      }));
      expect(result.verdict).toBe("blocked");
    });

    it("blocks when stdio has no command", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "mcp-server",
        mcpServer: { name: "test", transport: "stdio" },
      }));
      expect(result.verdict).toBe("blocked");
    });

    it("blocks when sse has no URL", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "mcp-server",
        mcpServer: { name: "test", transport: "sse" },
      }));
      expect(result.verdict).toBe("blocked");
    });

    it("passes with valid stdio server", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "mcp-server",
        mcpServer: { name: "test", transport: "stdio", command: "npx" },
      }));
      expect(result.verdict).toBe("ready");
      expect(result.permissionSummary.some((p) => p.includes("npx"))).toBe(true);
    });
  });

  describe("workflow-template", () => {
    it("blocks private workflow template URLs", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "workflow-template",
        workflowTemplate: { url: "http://169.254.169.254/latest/meta-data" },
      }));

      expect(result.verdict).toBe("blocked");
      expect(result.checks.some((c) => c.level === "blocking" && c.id === "workflow-url-private")).toBe(true);
    });

    it("passes public workflow template URLs", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "workflow-template",
        workflowTemplate: { url: "https://example.com/workflows/template.json" },
      }));

      expect(result.verdict).toBe("ready");
      expect(result.permissionSummary).toContain("Will import an external workflow template as a draft.");
      expect(result.permissionSummary).toContain("Draft must be reviewed before publish, deploy, or run.");
    });

    it("redacts token-bearing workflow template URLs from preview payloads", () => {
      const rawUrl = "https://example.com/workflows/template.json?token=workflow-preview-secret-token";
      const result = validateFridayDeepLink(makePayload({
        type: "workflow-template",
        workflowTemplate: { url: rawUrl },
      }));

      expect(result.payload.workflowTemplate?.url).not.toBe(rawUrl);
      expect(result.payload.workflowTemplate?.url).not.toContain("workflow-preview-secret-token");
      expect(result.payload.workflowTemplate?.url).toBe("https://example.com/workflows/template.json?redacted=1");
    });
  });

  describe("SSRF protection — private URL detection", () => {
    const privateUrls = [
      "http://127.0.0.1:8080/api",
      "http://10.0.0.1/internal",
      "http://192.168.1.100:11434/v1",
      "http://172.16.0.1/admin",
      "http://172.31.255.255/admin",
      "http://localhost:3000/skill",
      "http://[::1]:8080/api",
      "http://0.0.0.0:3000/probe",
      "http://169.254.169.254/metadata",
      "http://100.64.0.1/internal",
      "http://198.18.0.1/benchmark",
      "http://metadata.google.internal/computeMetadata/v1",
    ];

    for (const url of privateUrls) {
      it(`detects private URL: ${url}`, () => {
        const result = validateFridayDeepLink(makePayload({
          type: "skill-source",
          skillSource: { url },
        }));
        expect(result.checks.some((c) => c.level === "warning" && c.summary.toLowerCase().includes("private"))).toBe(true);
      });
    }

    it("allows public URLs", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "skill-source",
        skillSource: { url: "https://github.com/user/repo" },
      }));
      expect(result.checks.every((c) => !c.summary.toLowerCase().includes("private"))).toBe(true);
    });

    it("treats unparseable URLs as private (fail-closed)", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "skill-source",
        skillSource: { url: "not-a-url" },
      }));
      // Should either block or warn
      expect(result.checks.some((c) => c.level === "warning" || c.level === "blocking")).toBe(true);
    });
  });

  describe("integrity hash", () => {
    it("reports advisory when valid SHA-256 provided", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "provider-template",
        providerTemplate: { providerKind: "openai" },
        integrityHash: "a".repeat(64),
      }));
      expect(result.checks.find((c) => c.id === "integrity")?.level).toBe("advisory");
      expect(result.checks.find((c) => c.id === "integrity")?.summary).toContain("valid");
    });

    it("warns on invalid hash format", () => {
      const result = validateFridayDeepLink(makePayload({
        type: "provider-template",
        providerTemplate: { providerKind: "openai" },
        integrityHash: "not-a-hash",
      }));
      expect(result.checks.find((c) => c.id === "integrity")?.level).toBe("warning");
    });
  });
});
