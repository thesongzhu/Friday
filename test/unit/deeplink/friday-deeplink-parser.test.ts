import { describe, expect, it } from "vitest";
import { parseFridayDeepLinkUri, parseFridayDeepLinkJson } from "../../../src/deeplink/friday-deeplink-parser.js";

describe("parseFridayDeepLinkUri", () => {
  it("rejects non-friday:// URIs", () => {
    const result = parseFridayDeepLinkUri("https://example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("friday://");
  });

  it("rejects unknown resource types", () => {
    const result = parseFridayDeepLinkUri("friday://unknown-type");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown resource type");
  });

  it("parses provider-template URI", () => {
    const result = parseFridayDeepLinkUri("friday://provider-template?kind=openai&apiKey=$KEY&model=gpt-4o");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.type).toBe("provider-template");
      expect(result.payload.providerTemplate?.providerKind).toBe("openai");
      expect(result.payload.providerTemplate?.apiKey).toBe("$KEY");
      expect(result.payload.providerTemplate?.model).toBe("gpt-4o");
    }
  });

  it("parses skill-source URI with GitHub URL", () => {
    const result = parseFridayDeepLinkUri("friday://skill-source?url=https://github.com/user/repo&ref=main");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.type).toBe("skill-source");
      expect(result.payload.skillSource?.url).toBe("https://github.com/user/repo");
      expect(result.payload.skillSource?.ref).toBe("main");
    }
  });

  it("parses mcp-server URI", () => {
    const result = parseFridayDeepLinkUri("friday://mcp-server?name=test&transport=stdio&command=npx&args=-y,@test/mcp");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.type).toBe("mcp-server");
      expect(result.payload.mcpServer?.name).toBe("test");
      expect(result.payload.mcpServer?.transport).toBe("stdio");
      expect(result.payload.mcpServer?.command).toBe("npx");
      expect(result.payload.mcpServer?.args).toEqual(["-y", "@test/mcp"]);
    }
  });

  it("parses workflow-template URI", () => {
    const result = parseFridayDeepLinkUri("friday://workflow-template?url=https://example.com/workflow.json&name=My%20Workflow");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.type).toBe("workflow-template");
      expect(result.payload.workflowTemplate?.url).toBe("https://example.com/workflow.json");
      expect(result.payload.workflowTemplate?.name).toBe("My Workflow");
    }
  });

  it("extracts integrity hash and source", () => {
    const result = parseFridayDeepLinkUri(
      "friday://skill-source?url=https://example.com/skill.tgz&integrity=integrity-demo-value&source=trusted-repo",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.integrityHash).toBe("integrity-demo-value");
      expect(result.payload.source).toBe("trusted-repo");
    }
  });

  it("handles URI with no query params", () => {
    const result = parseFridayDeepLinkUri("friday://provider-template");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.type).toBe("provider-template");
      expect(result.payload.providerTemplate?.providerKind).toBe("");
    }
  });

  it("trims whitespace from URI", () => {
    const result = parseFridayDeepLinkUri("  friday://provider-template?kind=openai  ");
    expect(result.ok).toBe(true);
  });
});

describe("parseFridayDeepLinkJson", () => {
  it("rejects non-object payloads", () => {
    expect(parseFridayDeepLinkJson("string").ok).toBe(false);
    expect(parseFridayDeepLinkJson(null).ok).toBe(false);
    expect(parseFridayDeepLinkJson(42).ok).toBe(false);
  });

  it("rejects unsupported versions", () => {
    const result = parseFridayDeepLinkJson({ version: 2, type: "skill-source" });
    expect(result.ok).toBe(false);
  });

  it("rejects missing type", () => {
    const result = parseFridayDeepLinkJson({ version: 1 });
    expect(result.ok).toBe(false);
  });

  it("parses valid JSON payload", () => {
    const result = parseFridayDeepLinkJson({
      version: 1,
      type: "skill-source",
      label: "My Skill",
      source: "github",
      skillSource: { url: "https://github.com/user/repo" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.type).toBe("skill-source");
      expect(result.payload.label).toBe("My Skill");
      expect(result.payload.skillSource?.url).toBe("https://github.com/user/repo");
    }
  });

  it("uses default label when not provided", () => {
    const result = parseFridayDeepLinkJson({ version: 1, type: "mcp-server" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.label).toBe("Import mcp-server");
    }
  });
});
