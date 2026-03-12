import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFridayN8nNodeConverter } from "#skills/converter";
import type { FridaySkillConverterContext } from "#skills/converter";

const NOW_ISO = "2026-02-17T12:00:00.000Z";

function makeCtx(overrides: Partial<FridaySkillConverterContext> = {}): FridaySkillConverterContext {
  return {
    workspaceDir: "/workspace",
    managedSkillsDir: "/managed",
    nowIso: () => NOW_ISO,
    ...overrides,
  };
}

function makeN8nDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    displayName: "HTTP Request",
    name: "httpRequest",
    description: "Makes an HTTP request and returns the response data",
    group: ["transform"],
    version: 1,
    properties: [
      {
        displayName: "URL",
        name: "url",
        type: "string",
        default: "",
        description: "The URL to make the request to",
        required: true,
      },
      {
        displayName: "Method",
        name: "method",
        type: "options",
        default: "GET",
        description: "The HTTP method",
        options: [
          { name: "GET", value: "GET" },
          { name: "POST", value: "POST" },
          { name: "PUT", value: "PUT" },
          { name: "DELETE", value: "DELETE" },
        ],
      },
      {
        displayName: "Body",
        name: "body",
        type: "json",
        default: "{}",
        description: "The body of the request",
      },
      {
        displayName: "Timeout",
        name: "timeout",
        type: "number",
        default: 10000,
        description: "Timeout in milliseconds",
      },
      {
        displayName: "Follow Redirects",
        name: "followRedirects",
        type: "boolean",
        default: true,
        description: "Whether to follow redirects",
      },
    ],
    credentials: [
      { name: "httpBasicAuth", required: false },
    ],
    ...overrides,
  };
}

describe("N8nNodeConverter", () => {
  let testDir: string;
  const converter = createFridayN8nNodeConverter();

  beforeEach(() => {
    testDir = join(tmpdir(), `friday-test-n8n-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ─── detect ───

  describe("detect", () => {
    it("returns null for source without uri or contentBase64", async () => {
      const result = await converter.detect({});
      expect(result).toBeNull();
    });

    it("returns null for non-JSON content", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, "not valid json {{{");
      const result = await converter.detect({ uri: filePath });
      expect(result).toBeNull();
    });

    it("returns null for JSON without n8n signature", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify({ foo: "bar" }));
      const result = await converter.detect({ uri: filePath });
      expect(result).toBeNull();
    });

    it("detects n8n node descriptor from file", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify(makeN8nDescriptor()));
      const result = await converter.detect({ uri: filePath });
      expect(result).not.toBeNull();
      expect(result!.format).toBe("n8n-node");
      expect(result!.converterId).toBe("n8n-node");
      expect(result!.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("detects n8n node with higher confidence when group is present", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify(makeN8nDescriptor()));
      const result = await converter.detect({ uri: filePath });
      expect(result!.confidence).toBe(0.9);
    });

    it("detects n8n node from contentBase64", async () => {
      const content = JSON.stringify(makeN8nDescriptor());
      const base64 = Buffer.from(content).toString("base64");
      const result = await converter.detect({ contentBase64: base64 });
      expect(result).not.toBeNull();
      expect(result!.format).toBe("n8n-node");
    });

    it("detects n8n node from directory with node.json", async () => {
      writeFileSync(join(testDir, "node.json"), JSON.stringify(makeN8nDescriptor()));
      const result = await converter.detect({ uri: testDir });
      expect(result).not.toBeNull();
      expect(result!.format).toBe("n8n-node");
    });

    it("detects minimal n8n descriptor (name + properties)", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify({
        name: "myNode",
        properties: [{ name: "input", type: "string" }],
      }));
      const result = await converter.detect({ uri: filePath });
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.8);
    });
  });

  // ─── convert ───

  describe("convert", () => {
    it("throws when source has no resolvable content", async () => {
      await expect(converter.convert({}, makeCtx())).rejects.toThrow(
        "N8nNodeConverter requires a source URI",
      );
    });

    it("throws for invalid JSON", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, "not json");
      await expect(converter.convert({ uri: filePath }, makeCtx())).rejects.toThrow(
        "not valid JSON",
      );
    });

    it("throws for non-n8n JSON", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify({ foo: "bar" }));
      await expect(converter.convert({ uri: filePath }, makeCtx())).rejects.toThrow(
        "does not match n8n node descriptor shape",
      );
    });

    it("converts a basic n8n node descriptor", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify(makeN8nDescriptor()));

      const result = await converter.convert({ uri: filePath }, makeCtx());

      expect(result.converterId).toBe("n8n-node");
      expect(result.detectedFormat).toBe("n8n-node");
      expect(result.drafts).toHaveLength(1);

      const draft = result.drafts[0]!;

      // Manifest checks
      expect(draft.manifest.id).toBe("n8n-httprequest");
      expect(draft.manifest.name).toBe("HTTP Request");
      expect(draft.manifest.runtime.kind).toBe("node");
      expect(draft.manifest.runtime.entrypoint).toBe("index.mjs");
      expect(draft.manifest.category).toBe("integration");

      // Inputs from properties
      expect(draft.manifest.inputs.length).toBeGreaterThan(0);
      const urlInput = draft.manifest.inputs.find((i) => i.key === "url");
      expect(urlInput).toBeDefined();
      expect(urlInput!.type).toBe("string");
      expect(urlInput!.required).toBe(true);

      const methodInput = draft.manifest.inputs.find((i) => i.key === "method");
      expect(methodInput).toBeDefined();
      expect(methodInput!.validation?.enum).toEqual(["GET", "POST", "PUT", "DELETE"]);

      const bodyInput = draft.manifest.inputs.find((i) => i.key === "body");
      expect(bodyInput).toBeDefined();
      expect(bodyInput!.type).toBe("object");

      const timeoutInput = draft.manifest.inputs.find((i) => i.key === "timeout");
      expect(timeoutInput).toBeDefined();
      expect(timeoutInput!.type).toBe("number");

      const followInput = draft.manifest.inputs.find((i) => i.key === "followRedirects");
      expect(followInput).toBeDefined();
      expect(followInput!.type).toBe("boolean");

      // Outputs
      expect(draft.manifest.outputs).toHaveLength(2);
      expect(draft.manifest.outputs[0]!.key).toBe("result");
      expect(draft.manifest.outputs[1]!.key).toBe("status");

      // Files
      const filePaths = draft.files.map((f) => f.path);
      expect(filePaths).toContain("index.mjs");
      expect(filePaths).toContain("skill.manifest.json");
      expect(filePaths).toContain("skill.ui.json");
      expect(filePaths).toContain("n8n-node-descriptor.json");
      expect(filePaths).toContain("conversion.report.json");

      // Conversion report
      expect(draft.conversionReport.sourceFormat).toBe("n8n-node");
      expect(draft.conversionReport.convertedAt).toBe(NOW_ISO);
      expect(draft.conversionReport.converterId).toBe("n8n-node");
    });

    it("maps credentials to secret inputs with warnings", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify(makeN8nDescriptor()));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;

      // Should have credential as secret input
      const credInput = draft.manifest.inputs.find((i) => i.key === "httpBasicAuth_credential");
      expect(credInput).toBeDefined();
      expect(credInput!.type).toBe("secret");

      // Should have warning about credential mapping
      expect(draft.warnings.some((w) => w.includes("httpBasicAuth"))).toBe(true);

      // Requirements should include env var for credential
      expect(draft.manifest.requirements.env).toContain("N8N_CRED_HTTPBASICAUTH");
    });

    it("detects HTTP capability and adds network.connect permission", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify(makeN8nDescriptor()));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;

      // httpRequest should be detected as HTTP-capable
      const networkGrant = draft.manifest.permissions.grants.find((g) => g.id === "network.connect");
      expect(networkGrant).toBeDefined();
      expect(networkGrant!.resource).toBe("network");
      expect(draft.manifest.permissions.promptOn).toContain("network.connect");
    });

    it("warns about trigger/webhook nodes", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify(makeN8nDescriptor({
        name: "webhookTrigger",
        displayName: "Webhook Trigger",
        group: ["trigger"],
      })));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;

      expect(draft.warnings.some((w) => w.includes("Trigger/webhook node"))).toBe(true);
    });

    it("generates valid UI schema", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify(makeN8nDescriptor()));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const ui = result.drafts[0]!.uiSchema;

      expect(ui.schemaVersion).toBe("1.0");
      expect(ui.title).toBe("HTTP Request");
      expect(ui.sections).toHaveLength(1);

      // URL field should be text
      const urlField = ui.fields.find((f) => f.inputKey === "url");
      expect(urlField).toBeDefined();
      expect(urlField!.kind).toBe("text");

      // Method field should be select (options type)
      const methodField = ui.fields.find((f) => f.inputKey === "method");
      expect(methodField).toBeDefined();
      expect(methodField!.kind).toBe("select");

      // Body field should be json
      const bodyField = ui.fields.find((f) => f.inputKey === "body");
      expect(bodyField).toBeDefined();
      expect(bodyField!.kind).toBe("json");

      // Timeout should be number
      const timeoutField = ui.fields.find((f) => f.inputKey === "timeout");
      expect(timeoutField).toBeDefined();
      expect(timeoutField!.kind).toBe("number");

      // Boolean should be toggle
      const boolField = ui.fields.find((f) => f.inputKey === "followRedirects");
      expect(boolField).toBeDefined();
      expect(boolField!.kind).toBe("toggle");

      expect(ui.actions).toHaveLength(2);
      expect(ui.outputs).toHaveLength(2);
    });

    it("converts from contentBase64", async () => {
      const content = JSON.stringify(makeN8nDescriptor({
        name: "simpleNode",
        displayName: "Simple Node",
        properties: [
          { name: "message", type: "string", displayName: "Message", default: "hello" },
        ],
        credentials: [],
        group: [],
      }));
      const base64 = Buffer.from(content).toString("base64");

      const result = await converter.convert({ contentBase64: base64 }, makeCtx());
      const draft = result.drafts[0]!;

      expect(draft.manifest.id).toBe("n8n-simplenode");
      expect(draft.manifest.inputs).toHaveLength(1);
      expect(draft.manifest.inputs[0]!.key).toBe("message");
    });

    it("generates functional n8n adapter with node execution support", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify(makeN8nDescriptor()));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const indexFile = result.drafts[0]!.files.find((f) => f.path === "index.mjs")!;

      // Should attempt to import the actual n8n node module
      expect(indexFile.content).toContain("await import(");
      expect(indexFile.content).toContain('"httpRequest"');

      // Should build n8n execution context
      expect(indexFile.content).toContain("getInputData");
      expect(indexFile.content).toContain("getNodeParameter");
      expect(indexFile.content).toContain("getCredentials");

      // Should handle the execute method
      expect(indexFile.content).toContain("nodeInstance.execute");

      // Should map n8n output back to Friday format
      expect(indexFile.content).toContain("resultData");

      // Should have fallback when module not found
      expect(indexFile.content).toContain("n8n node module not found");

      // Should map credentials from env vars
      expect(indexFile.content).toContain("N8N_CRED_HTTPBASICAUTH");
    });

    it("generates index.mjs with proper parameter mapping", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify(makeN8nDescriptor({
        name: "testNode",
        properties: [
          { name: "input1", type: "string", default: "default1" },
          { name: "count", type: "number", default: 5 },
        ],
        credentials: [],
        group: [],
      })));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const indexFile = result.drafts[0]!.files.find((f) => f.path === "index.mjs")!;

      expect(indexFile.content).toContain("export default async function execute");
      expect(indexFile.content).toContain("getNodeParameter");
      expect(indexFile.content).toContain('"input1"');
      expect(indexFile.content).toContain('"count"');
    });

    it("handles node without HTTP capability (no network permission)", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify({
        name: "mathNode",
        displayName: "Math Calculator",
        properties: [
          { name: "operation", type: "options", options: [{ name: "add", value: "add" }] },
          { name: "value", type: "number", default: 0 },
        ],
      }));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;

      expect(draft.manifest.permissions.grants).toHaveLength(0);
      expect(draft.manifest.permissions.promptOn).toHaveLength(0);
    });
  });
});
