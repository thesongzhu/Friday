import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFridayOpenAiGptActionConverter } from "#skills/converter";
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

function makeOpenApiSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: {
      title: "Pet Store API",
      description: "A sample pet store API",
      version: "1.0.0",
    },
    servers: [
      { url: "https://api.petstore.example.com/v1", description: "Production" },
    ],
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          summary: "List all pets",
          description: "Returns a list of pets",
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Maximum number of pets to return",
              schema: { type: "integer", default: 10 },
            },
            {
              name: "species",
              in: "query",
              required: false,
              description: "Filter by species",
              schema: { type: "string", enum: ["dog", "cat", "bird"] },
            },
          ],
          responses: {
            "200": { description: "A list of pets" },
          },
        },
        post: {
          operationId: "createPet",
          summary: "Create a pet",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Pet name" },
                    species: { type: "string", description: "Pet species", enum: ["dog", "cat", "bird"] },
                    age: { type: "integer", description: "Pet age" },
                  },
                  required: ["name", "species"],
                },
              },
            },
          },
          responses: {
            "201": { description: "Pet created" },
          },
        },
      },
      "/pets/{petId}": {
        get: {
          operationId: "getPet",
          summary: "Get a pet by ID",
          parameters: [
            {
              name: "petId",
              in: "path",
              required: true,
              description: "The pet ID",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "The pet" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
        },
      },
    },
    ...overrides,
  };
}

describe("OpenAiGptActionConverter", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `friday-test-openapi-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ─── detect ───

  describe("detect", () => {
    it("returns null for source without uri or contentBase64", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const result = await converter.detect({});
      expect(result).toBeNull();
    });

    it("returns null for non-JSON content", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, "not json");
      const result = await converter.detect({ uri: filePath });
      expect(result).toBeNull();
    });

    it("returns null for JSON without OpenAPI signature", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify({ foo: "bar" }));
      const result = await converter.detect({ uri: filePath });
      expect(result).toBeNull();
    });

    it("detects OpenAPI 3.0 spec at high confidence", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));
      const result = await converter.detect({ uri: filePath });
      expect(result).not.toBeNull();
      expect(result!.format).toBe("openai-gpt-action");
      expect(result!.converterId).toBe("openai-gpt-action");
      expect(result!.confidence).toBe(0.95);
    });

    it("detects Swagger 2.0 spec", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify({
        swagger: "2.0",
        info: { title: "Old API", version: "1.0" },
        paths: { "/test": { get: { operationId: "test" } } },
      }));
      const result = await converter.detect({ uri: filePath });
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.9);
    });

    it("detects from contentBase64", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const content = JSON.stringify(makeOpenApiSpec());
      const base64 = Buffer.from(content).toString("base64");
      const result = await converter.detect({ contentBase64: base64 });
      expect(result).not.toBeNull();
      expect(result!.format).toBe("openai-gpt-action");
    });

    it("detects from directory with openapi.json", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      writeFileSync(join(testDir, "openapi.json"), JSON.stringify(makeOpenApiSpec()));
      const result = await converter.detect({ uri: testDir });
      expect(result).not.toBeNull();
    });
  });

  // ─── convert (split operations = true) ───

  describe("convert (split operations)", () => {
    it("throws when source has no resolvable content", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      await expect(converter.convert({}, makeCtx())).rejects.toThrow(
        "requires a source URI",
      );
    });

    it("throws for invalid JSON", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, "not json");
      await expect(converter.convert({ uri: filePath }, makeCtx())).rejects.toThrow(
        "not valid JSON",
      );
    });

    it("throws for non-OpenAPI JSON", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify({ foo: "bar" }));
      await expect(converter.convert({ uri: filePath }, makeCtx())).rejects.toThrow(
        "does not match OpenAPI",
      );
    });

    it("throws when no operations found", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Empty", version: "1.0" },
        paths: {},
      }));
      await expect(converter.convert({ uri: filePath }, makeCtx())).rejects.toThrow(
        "no operations found",
      );
    });

    it("converts OpenAPI spec to one skill per operation", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));

      const result = await converter.convert({ uri: filePath }, makeCtx());

      expect(result.converterId).toBe("openai-gpt-action");
      expect(result.detectedFormat).toBe("openai-gpt-action");
      // 3 operations: listPets, createPet, getPet
      expect(result.drafts).toHaveLength(3);

      // Check listPets draft
      const listDraft = result.drafts.find((d) => d.manifest.id.includes("listpets"));
      expect(listDraft).toBeDefined();
      expect(listDraft!.manifest.name).toBe("List all pets");
      expect(listDraft!.manifest.runtime.kind).toBe("node");
      expect(listDraft!.manifest.runtime.entrypoint).toBe("index.mjs");

      // listPets should have limit and species inputs
      const limitInput = listDraft!.manifest.inputs.find((i) => i.key === "limit");
      expect(limitInput).toBeDefined();
      expect(limitInput!.type).toBe("number");

      const speciesInput = listDraft!.manifest.inputs.find((i) => i.key === "species");
      expect(speciesInput).toBeDefined();
      expect(speciesInput!.validation?.enum).toEqual(["dog", "cat", "bird"]);

      // Check createPet draft
      const createDraft = result.drafts.find((d) => d.manifest.id.includes("createpet"));
      expect(createDraft).toBeDefined();

      // Body parameters should be prefixed with body_
      const bodyName = createDraft!.manifest.inputs.find((i) => i.key === "body_name");
      expect(bodyName).toBeDefined();
      expect(bodyName!.type).toBe("string");
      expect(bodyName!.required).toBe(true);

      const bodySpecies = createDraft!.manifest.inputs.find((i) => i.key === "body_species");
      expect(bodySpecies).toBeDefined();

      // Check getPet draft
      const getDraft = result.drafts.find((d) => d.manifest.id.includes("getpet"));
      expect(getDraft).toBeDefined();
      const petIdInput = getDraft!.manifest.inputs.find((i) => i.key === "petId");
      expect(petIdInput).toBeDefined();
      expect(petIdInput!.required).toBe(true);
    });

    it("includes auth inputs for API key security scheme", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;

      // Should have auth input for apiKey
      const authInput = draft.manifest.inputs.find((i) => i.key === "auth_apiKey");
      expect(authInput).toBeDefined();
      expect(authInput!.type).toBe("secret");
      expect(authInput!.required).toBe(true);

      // Requirements should include env var
      expect(draft.manifest.requirements.env).toContain("AUTH_APIKEY");
    });

    it("adds network.connect permission with host allowlist", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;

      const networkGrant = draft.manifest.permissions.grants.find((g) => g.id === "network.connect");
      expect(networkGrant).toBeDefined();
      expect(networkGrant!.selectors?.hostAllowlist).toContain("api.petstore.example.com");
      expect(draft.manifest.permissions.promptOn).toContain("network.connect");
    });

    it("generates correct outputs (status, headers, data)", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const outputs = result.drafts[0]!.manifest.outputs;

      expect(outputs).toHaveLength(3);
      expect(outputs.map((o) => o.key)).toEqual(["status", "headers", "data"]);
      expect(outputs[0]!.type).toBe("number");
      expect(outputs[1]!.type).toBe("object");
      expect(outputs[2]!.type).toBe("object");
    });

    it("generates required files", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;

      const filePaths = draft.files.map((f) => f.path);
      expect(filePaths).toContain("index.mjs");
      expect(filePaths).toContain("skill.manifest.json");
      expect(filePaths).toContain("skill.ui.json");
      expect(filePaths).toContain("conversion.report.json");
    });

    it("generates index.mjs with proper HTTP executor", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));

      const result = await converter.convert({ uri: filePath }, makeCtx());

      // getPet should have path param substitution
      const getDraft = result.drafts.find((d) => d.manifest.id.includes("getpet"));
      const indexMjs = getDraft!.files.find((f) => f.path === "index.mjs")!;

      expect(indexMjs.content).toContain("export default async function execute");
      expect(indexMjs.content).toContain("fetch(url");
      expect(indexMjs.content).toContain("{petId}");
      expect(indexMjs.content).toContain("GET");
    });

    it("generates valid UI schema", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const ui = result.drafts[0]!.uiSchema;

      expect(ui.schemaVersion).toBe("1.0");
      expect(ui.sections).toHaveLength(1);
      expect(ui.actions).toHaveLength(2);
      expect(ui.outputs).toHaveLength(3);
    });

    it("conversion report has correct metadata", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const report = result.drafts[0]!.conversionReport;

      expect(report.sourceFormat).toBe("openai-gpt-action");
      expect(report.convertedAt).toBe(NOW_ISO);
      expect(report.converterId).toBe("openai-gpt-action");
      expect(report.sourceRef).toBe(filePath);
    });
  });

  // ─── convert (split operations = false) ───

  describe("convert (combined)", () => {
    it("creates single skill with operation selector", async () => {
      const converter = createFridayOpenAiGptActionConverter({ splitOperations: false });
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));

      const result = await converter.convert({ uri: filePath }, makeCtx());

      expect(result.drafts).toHaveLength(1);

      const draft = result.drafts[0]!;
      expect(draft.manifest.name).toBe("Pet Store API");

      // Should have operation selector input
      const opInput = draft.manifest.inputs.find((i) => i.key === "operation");
      expect(opInput).toBeDefined();
      expect(opInput!.type).toBe("string");
      expect(opInput!.required).toBe(true);
      expect(opInput!.validation?.enum).toContain("listPets");
      expect(opInput!.validation?.enum).toContain("createPet");
      expect(opInput!.validation?.enum).toContain("getPet");

      // index.mjs should have switch statement
      const indexMjs = draft.files.find((f) => f.path === "index.mjs")!;
      expect(indexMjs.content).toContain("switch");
      expect(indexMjs.content).toContain("listPets");
    });

    it("combined mode handles path/query/body per operation", async () => {
      const converter = createFridayOpenAiGptActionConverter({ splitOperations: false });
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;
      const indexMjs = draft.files.find((f) => f.path === "index.mjs")!;

      // Each operation should have its own function with full param handling
      expect(indexMjs.content).toContain("op_listPets");
      expect(indexMjs.content).toContain("op_createPet");
      expect(indexMjs.content).toContain("op_getPet");

      // getPet handler should include path parameter substitution
      expect(indexMjs.content).toContain("{petId}");
      expect(indexMjs.content).toContain("encodeURIComponent");

      // listPets handler should include query parameter handling
      expect(indexMjs.content).toContain("queryParams");

      // createPet handler should include body handling
      expect(indexMjs.content).toContain("body_name");
    });

    it("skips null query/header values in generated operation handlers", async () => {
      const converter = createFridayOpenAiGptActionConverter({ splitOperations: false });
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec({
        paths: {
          "/search": {
            get: {
              operationId: "search",
              parameters: [
                { name: "q", in: "query", schema: { type: "string" } },
                { name: "X-Trace", in: "header", schema: { type: "string" } },
              ],
            },
          },
        },
      })));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const indexMjs = result.drafts[0]!.files.find((f) => f.path === "index.mjs")!;

      expect(indexMjs.content).toContain('inputs["q"] !== undefined && inputs["q"] !== null');
      expect(indexMjs.content).toContain('inputs["X-Trace"] !== undefined && inputs["X-Trace"] !== null');
    });

    it("escapes generated operation comments and path parameter replacement tokens", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      const unsafePath = '/pets/*/\nthrow new Error("pwned")\n/*';
      const unsafeParamName = 'petId"); throw new Error("pwned");//';
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec({
        paths: {
          [unsafePath]: {
            get: {
              operationId: "getPet",
              parameters: [
                { name: unsafeParamName, in: "path", schema: { type: "string" } },
              ],
            },
          },
        },
      })));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const indexMjs = result.drafts[0]!.files.find((f) => f.path === "index.mjs")!;

      expect(indexMjs.content).toContain("*\\/");
      expect(indexMjs.content).not.toContain('*/\nthrow new Error("pwned")');
      expect(indexMjs.content).toContain(`url = url.replace(${JSON.stringify(`{${unsafeParamName}}`)},`);
      expect(indexMjs.content).not.toContain(`url = url.replace("{${unsafeParamName}}",`);
      expect(() =>
        new Function(indexMjs.content.replace("export default async function execute", "async function execute")),
      ).not.toThrow();
    });

    it("fails closed when generated operation handlers are missing required path params", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec({
        paths: {
          "/pets/{petId}": {
            get: {
              operationId: "getPet",
              parameters: [
                { name: "petId", in: "path", required: true, schema: { type: "string" } },
              ],
            },
          },
        },
      })));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const indexMjs = result.drafts[0]!.files.find((f) => f.path === "index.mjs")!;

      expect(indexMjs.content).toContain('if (inputs["petId"] === undefined || inputs["petId"] === null)');
      expect(indexMjs.content).toContain("Missing required path parameter: petId");
      expect(indexMjs.content).not.toContain('String(inputs["petId"] ?? "")');
    });

    it("generates unique handler names for sanitized operation id collisions", async () => {
      const converter = createFridayOpenAiGptActionConverter({ splitOperations: false });
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec({
        paths: {
          "/one": { get: { operationId: "same-name" } },
          "/two": { get: { operationId: "same_name" } },
        },
      })));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const indexMjs = result.drafts[0]!.files.find((f) => f.path === "index.mjs")!;

      expect(indexMjs.content).toContain("async function op_same_name(");
      expect(indexMjs.content).toContain("async function op_same_name_2(");
      expect(indexMjs.content).toContain("return await op_same_name_2(inputs, env);");
    });
  });

  // ─── skillIdPrefix ───

  describe("skillIdPrefix option", () => {
    it("uses prefix for skill IDs", async () => {
      const converter = createFridayOpenAiGptActionConverter({ skillIdPrefix: "my-app" });
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec()));

      const result = await converter.convert({ uri: filePath }, makeCtx());

      for (const draft of result.drafts) {
        expect(draft.manifest.id).toMatch(/^my-app-/);
      }
    });
  });

  // ─── YAML support ───

  describe("YAML support", () => {
    it("detects YAML OpenAPI spec", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.yaml");
      writeFileSync(filePath, `openapi: "3.0.0"
info:
  title: YAML API
  version: "1.0"
paths:
  /test:
    get:
      operationId: testOp
      summary: Test operation
      responses:
        "200":
          description: OK
`);
      const result = await converter.detect({ uri: filePath });
      expect(result).not.toBeNull();
      expect(result!.format).toBe("openai-gpt-action");
      expect(result!.confidence).toBe(0.95);
    });

    it("converts YAML OpenAPI spec", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.yaml");
      writeFileSync(filePath, `openapi: "3.0.0"
info:
  title: YAML API
  version: "1.0"
servers:
  - url: https://api.yaml-test.com
paths:
  /items:
    get:
      operationId: listItems
      summary: List items
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
      responses:
        "200":
          description: Items list
`);
      const result = await converter.convert({ uri: filePath }, makeCtx());
      expect(result.drafts).toHaveLength(1);
      expect(result.drafts[0]!.manifest.name).toBe("List items");
    });

    it("detects YAML file in directory (openapi.yaml)", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      writeFileSync(join(testDir, "openapi.yaml"), `openapi: "3.0.0"
info:
  title: Dir YAML API
  version: "1.0"
paths:
  /test:
    get:
      operationId: dirTest
      responses:
        "200":
          description: OK
`);
      const result = await converter.detect({ uri: testDir });
      expect(result).not.toBeNull();
    });
  });

  // ─── Auth schemes ───

  describe("auth scheme mapping", () => {
    it("maps Bearer token to secret input", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec({
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
            },
          },
        },
      })));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;

      const authInput = draft.manifest.inputs.find((i) => i.key === "auth_bearerAuth");
      expect(authInput).toBeDefined();
      expect(authInput!.type).toBe("secret");
      expect(authInput!.label).toContain("Bearer Token");
    });

    it("handles API key in query parameter", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec({
        components: {
          securitySchemes: {
            queryAuth: {
              type: "apiKey",
              in: "query",
              name: "api_key",
            },
          },
        },
      })));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;
      const indexMjs = draft.files.find((f) => f.path === "index.mjs")!;

      // Should append to query params
      expect(indexMjs.content).toContain("queryParams.set");
      expect(indexMjs.content).toContain("api_key");
    });

    it("sanitizes security scheme names before using them in auth inputs and generated code", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      const schemeName = 'api-key"]; throw new Error("pwned");//';
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec({
        components: {
          securitySchemes: {
            [schemeName]: {
              type: "apiKey",
              in: "header",
              name: "X-API-Key",
            },
          },
        },
      })));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;
      const indexMjs = draft.files.find((f) => f.path === "index.mjs")!;
      const authInput = draft.manifest.inputs.find((input) => input.type === "secret")!;
      const envVar = draft.manifest.requirements.env[0]!;

      expect(authInput.key).toMatch(/^auth_[A-Za-z0-9_]+$/);
      expect(envVar).toMatch(/^AUTH_[A-Z0-9_]+$/);
      expect(indexMjs.content).toContain(`inputs[${JSON.stringify(authInput.key)}]`);
      expect(indexMjs.content).toContain(`env[${JSON.stringify(envVar)}]`);
      expect(indexMjs.content).not.toContain("inputs.auth_");
      expect(indexMjs.content).not.toContain("env.AUTH_");
      expect(indexMjs.content).not.toContain(schemeName);
      expect(indexMjs.content).not.toContain("throw new Error");
    });

    it("handles API key in cookie", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec({
        components: {
          securitySchemes: {
            cookieAuth: {
              type: "apiKey",
              in: "cookie",
              name: "session_id",
            },
          },
        },
      })));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;
      const indexMjs = draft.files.find((f) => f.path === "index.mjs")!;

      // Should set Cookie header
      expect(indexMjs.content).toContain("Cookie");
      expect(indexMjs.content).toContain("session_id=");
    });

    it("warns about OAuth2 scheme", async () => {
      const converter = createFridayOpenAiGptActionConverter();
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify(makeOpenApiSpec({
        components: {
          securitySchemes: {
            oauth2: {
              type: "oauth2",
              flows: { implicit: { authorizationUrl: "https://auth.example.com" } },
            },
          },
        },
      })));

      const result = await converter.convert({ uri: filePath }, makeCtx());
      const draft = result.drafts[0]!;

      expect(draft.warnings.some((w) => w.includes("OAuth2"))).toBe(true);
      expect(draft.warnings.some((w) => w.includes("manual post-import setup"))).toBe(true);
    });
  });
});
