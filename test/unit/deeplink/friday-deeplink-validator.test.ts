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
      expect(result.permissionSummary.length).toBeGreaterThan(0);
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
