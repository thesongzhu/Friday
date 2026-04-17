/**
 * OpenAI GPT Action (OpenAPI) → Friday Package converter.
 *
 * Detects OpenAPI/Swagger specs and converts each operation into a
 * Friday skill package with an HTTP executor.
 *
 * Supports:
 *   - splitOperations option (default true): one skill per operation
 *   - skillIdPrefix option
 *   - Auth mapping: API key → secret, Bearer → secret, OAuth2 → warning
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import { FridayDomainError } from "#errors";

import type { SkillManifestV2 } from "../../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillUiSchemaV1 } from "../../generator/model/friday-skill-ui-schema.types.js";
import type {
  FridayConvertedSkillDraft,
  FridayConvertedSkillFile,
  FridaySkillConversionSource,
  FridaySkillConverter,
  FridaySkillConverterContext,
  FridaySkillConverterDetection,
  FridaySkillConverterResult,
} from "../model/friday-skill-converter.types.js";

// ─── Constants ───

const CONVERTER_ID = "openai-gpt-action";
const CONVERTER_DISPLAY_NAME = "OpenAI GPT Action (OpenAPI)";
const CONVERTER_PRIORITY = 40;

// ─── OpenAPI structures (minimal subset) ───

interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: { type?: string; enum?: string[]; default?: unknown };
}

interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: OpenApiSchemaObject }>;
}

interface OpenApiSchemaObject {
  type?: string;
  properties?: Record<string, { type?: string; description?: string; enum?: string[]; default?: unknown }>;
  required?: string[];
  items?: { type?: string };
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, { description?: string }>;
  security?: Array<Record<string, string[]>>;
}

interface OpenApiSecurityScheme {
  type: string;
  scheme?: string;
  in?: string;
  name?: string;
  flows?: Record<string, unknown>;
}

interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; description?: string; version?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
}

// ─── Converter options ───

export interface OpenAiGptActionConverterOptions {
  splitOperations?: boolean;
  skillIdPrefix?: string;
}

// ─── Factory ───

export function createFridayOpenAiGptActionConverter(
  options?: OpenAiGptActionConverterOptions,
): FridaySkillConverter {
  const splitOperations = options?.splitOperations ?? true;
  const skillIdPrefix = options?.skillIdPrefix;

  return {
    id: CONVERTER_ID,
    displayName: CONVERTER_DISPLAY_NAME,
    priority: CONVERTER_PRIORITY,

    async detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null> {
      const content = resolveSourceContent(source);
      if (!content) {
        return null;
      }

      const parsed = parseJsonOrYaml(content);
      if (parsed === null) {
        return null;
      }

      if (!isOpenApiSpec(parsed)) {
        return null;
      }

      const spec = parsed as OpenApiSpec;
      const reasons: string[] = [];
      let confidence = 0.8;

      if (spec.openapi) {
        reasons.push(`OpenAPI version: ${spec.openapi}`);
        confidence = 0.95;
      } else if (spec.swagger) {
        reasons.push(`Swagger version: ${spec.swagger}`);
        confidence = 0.9;
      }

      if (spec.paths && Object.keys(spec.paths).length > 0) {
        reasons.push(`Found ${Object.keys(spec.paths).length} path(s)`);
      }

      if (spec.info?.title) {
        reasons.push(`API title: ${spec.info.title}`);
      }

      return {
        converterId: CONVERTER_ID,
        format: "openai-gpt-action",
        confidence,
        reasons,
      };
    },

    async convert(
      source: FridaySkillConversionSource,
      ctx: FridaySkillConverterContext,
    ): Promise<FridaySkillConverterResult> {
      const content = resolveSourceContent(source);
      if (!content) {
        throw new FridayDomainError("VALIDATION_ERROR", "OpenAiGptActionConverter requires a source URI pointing to an OpenAPI JSON/YAML file or contentBase64", { httpStatus: 400 });
      }

      const parsed = parseJsonOrYaml(content);
      if (parsed === null) {
        throw new FridayDomainError("PARSE_ERROR", "OpenAiGptActionConverter: source is not valid JSON or YAML", { httpStatus: 422 });
      }

      if (!isOpenApiSpec(parsed)) {
        throw new FridayDomainError("PARSE_ERROR", "OpenAiGptActionConverter: source does not match OpenAPI/Swagger spec shape", { httpStatus: 422 });
      }

      const spec = parsed as OpenApiSpec;
      const operations = extractOperations(spec);

      if (operations.length === 0) {
        throw new FridayDomainError("VALIDATION_ERROR", "OpenAiGptActionConverter: no operations found in OpenAPI spec", { httpStatus: 422 });
      }

      const serverHosts = extractServerHosts(spec);
      const baseUrl = spec.servers?.[0]?.url ?? "";
      const authInfo = extractAuthInfo(spec);
      const baseId = buildBaseId(spec, source, skillIdPrefix);

      const drafts: FridayConvertedSkillDraft[] = [];

      if (splitOperations) {
        // One skill per operation
        for (const op of operations) {
          const draft = buildOperationDraft(
            op,
            spec,
            baseId,
            baseUrl,
            serverHosts,
            authInfo,
            ctx,
            source,
          );
          drafts.push(draft);
        }
      } else {
        // Single skill for all operations (use first operation's details)
        const draft = buildCombinedDraft(
          operations,
          spec,
          baseId,
          baseUrl,
          serverHosts,
          authInfo,
          ctx,
          source,
        );
        drafts.push(draft);
      }

      return {
        converterId: CONVERTER_ID,
        detectedFormat: "openai-gpt-action",
        drafts,
      };
    },
  };
}

// ─── Types ───

interface ExtractedOperation {
  path: string;
  method: string;
  operation: OpenApiOperation;
  operationId: string;
}

interface AuthInfo {
  schemes: Array<{
    name: string;
    type: string;
    scheme?: string;
    inLocation?: string;
    headerName?: string;
  }>;
  warnings: string[];
}

// ─── Source resolution ───

function resolveSourceContent(source: FridaySkillConversionSource): string | null {
  if (source.contentBase64) {
    try {
      return Buffer.from(source.contentBase64, "base64").toString("utf-8");
    } catch (err) {
    console.warn("[friday][openai-gpt-action-converter] operation failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  if (!source.uri) {
    return null;
  }

  // Try reading directly as a file
  if (existsSync(source.uri)) {
    try {
      if (statSync(source.uri).isFile()) {
        return readFileSync(source.uri, "utf-8");
      }
    } catch (err) {
      console.warn("[friday][openai-gpt-action-converter] operation failed:", err instanceof Error ? err.message : String(err));
      // Stat failure on the source path; continue to candidate file probing.
    }

    // Try common OpenAPI file names in directory
    for (const candidate of [
      "openapi.json", "swagger.json", "api.json", "spec.json",
      "openapi.yaml", "openapi.yml", "swagger.yaml", "swagger.yml",
      "api.yaml", "api.yml", "spec.yaml", "spec.yml",
    ]) {
      const filePath = join(source.uri, candidate);
      if (existsSync(filePath)) {
        try {
          return readFileSync(filePath, "utf-8");
        } catch (err) {
    console.warn("[friday][openai-gpt-action-converter] operation failed:", err instanceof Error ? err.message : String(err));
          continue;
        }
      }
    }
  }

  return null;
}

// ─── Parsing ───

function parseJsonOrYaml(content: string): unknown | null {
  // Try JSON first
  try {
    return JSON.parse(content);
  } catch (err) {
    console.warn("[friday][openai-gpt-action-converter] operation failed:", err instanceof Error ? err.message : String(err));
    // Not JSON, try YAML
  }

  try {
    const result = YAML.parse(content);
    if (result && typeof result === "object") {
      return result;
    }
  } catch (err) {
    console.warn("[friday][openai-gpt-action-converter] operation failed:", err instanceof Error ? err.message : String(err));
    // Not YAML either
  }

  return null;
}

// ─── Detection ───

function isOpenApiSpec(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const record = obj as Record<string, unknown>;

  // Must have openapi or swagger field
  const hasOpenapi = typeof record["openapi"] === "string";
  const hasSwagger = typeof record["swagger"] === "string";

  if (!hasOpenapi && !hasSwagger) {
    return false;
  }

  // Must have paths or info
  const hasPaths = record["paths"] !== undefined && typeof record["paths"] === "object";
  const hasInfo = record["info"] !== undefined && typeof record["info"] === "object";

  return hasPaths || hasInfo;
}

// ─── Extraction ───

function extractOperations(spec: OpenApiSpec): ExtractedOperation[] {
  const operations: ExtractedOperation[] = [];
  const paths = spec.paths ?? {};

  const httpMethods = ["get", "post", "put", "patch", "delete", "options", "head"];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of httpMethods) {
      const operation = (pathItem as Record<string, unknown>)[method] as OpenApiOperation | undefined;
      if (!operation || typeof operation !== "object") {
        continue;
      }

      const operationId = operation.operationId ?? `${method}-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;

      operations.push({
        path,
        method: method.toUpperCase(),
        operation,
        operationId,
      });
    }
  }

  return operations;
}

function extractServerHosts(spec: OpenApiSpec): string[] {
  const servers = spec.servers ?? [];
  const hosts: string[] = [];

  for (const server of servers) {
    try {
      const url = new URL(server.url);
      if (url.hostname && !hosts.includes(url.hostname)) {
        hosts.push(url.hostname);
      }
    } catch (err) {
    console.warn("[friday][openai-gpt-action-converter] operation failed:", err instanceof Error ? err.message : String(err));
      // Not a valid URL, skip
    }
  }

  return hosts;
}

function extractAuthInfo(spec: OpenApiSpec): AuthInfo {
  const schemes: AuthInfo["schemes"] = [];
  const warnings: string[] = [];
  const securitySchemes = spec.components?.securitySchemes ?? {};

  for (const [name, scheme] of Object.entries(securitySchemes)) {
    if (scheme.type === "apiKey") {
      schemes.push({
        name,
        type: "apiKey",
        inLocation: scheme.in,
        headerName: scheme.name,
      });
    } else if (scheme.type === "http") {
      schemes.push({
        name,
        type: "http",
        scheme: scheme.scheme,
      });
    } else if (scheme.type === "oauth2") {
      schemes.push({
        name,
        type: "oauth2",
      });
      warnings.push(`OAuth2 security scheme "${name}" detected — manual post-import setup required.`);
    }
  }

  return { schemes, warnings };
}

// ─── ID helpers ───

function buildBaseId(
  spec: OpenApiSpec,
  source: FridaySkillConversionSource,
  prefix?: string,
): string {
  const rawId = prefix
    ?? spec.info?.title
    ?? (source.uri ? basename(source.uri, ".json") : "openapi-action");

  return sanitizeSkillId(rawId);
}

function sanitizeSkillId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function sanitizeJsIdentifier(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ─── Draft builders ───

function buildOperationDraft(
  op: ExtractedOperation,
  spec: OpenApiSpec,
  baseId: string,
  baseUrl: string,
  serverHosts: string[],
  authInfo: AuthInfo,
  ctx: FridaySkillConverterContext,
  source: FridaySkillConversionSource,
): FridayConvertedSkillDraft {
  const skillId = `${baseId}-${sanitizeSkillId(op.operationId)}`;
  const warnings = [...authInfo.warnings];

  const manifest = buildOperationManifest(op, skillId, serverHosts, authInfo, warnings);
  const uiSchema = buildOperationUiSchema(manifest);
  const indexMjs = buildOperationIndexMjs(op, baseUrl, authInfo);

  const files: FridayConvertedSkillFile[] = [
    { path: "index.mjs", content: indexMjs },
    { path: "skill.manifest.json", content: JSON.stringify(manifest, null, 2) },
    { path: "skill.ui.json", content: JSON.stringify(uiSchema, null, 2) },
  ];

  const conversionReport = {
    sourceFormat: "openai-gpt-action" as const,
    sourceRef: source.uri,
    convertedAt: ctx.nowIso(),
    converterId: CONVERTER_ID,
  };

  files.push({
    path: "conversion.report.json",
    content: JSON.stringify(conversionReport, null, 2),
  });

  return {
    manifest,
    uiSchema,
    files,
    warnings,
    conversionReport,
  };
}

function buildCombinedDraft(
  operations: ExtractedOperation[],
  spec: OpenApiSpec,
  baseId: string,
  baseUrl: string,
  serverHosts: string[],
  authInfo: AuthInfo,
  ctx: FridaySkillConverterContext,
  source: FridaySkillConversionSource,
): FridayConvertedSkillDraft {
  const skillId = baseId;
  const warnings = [...authInfo.warnings];

  // Combine all inputs from all operations
  const allInputs: SkillManifestV2["inputs"] = [];
  const seenKeys = new Set<string>();

  // Add operation selector
  allInputs.push({
    key: "operation",
    type: "string",
    required: true,
    label: "Operation",
    help: "Select which API operation to execute",
    validation: {
      enum: operations.map((op) => op.operationId),
    },
  });
  seenKeys.add("operation");

  for (const op of operations) {
    const params = extractOperationInputs(op);
    for (const input of params) {
      if (!seenKeys.has(input.key)) {
        seenKeys.add(input.key);
        allInputs.push(input);
      }
    }
  }

  // Add auth inputs
  const authInputs = buildAuthInputs(authInfo, warnings);
  for (const input of authInputs) {
    if (!seenKeys.has(input.key)) {
      seenKeys.add(input.key);
      allInputs.push(input);
    }
  }

  const grants = buildPermissionGrants(serverHosts);

  const manifest: SkillManifestV2 = {
    schemaVersion: "2.0",
    id: skillId,
    name: spec.info?.title ?? skillId,
    description: spec.info?.description ?? `OpenAPI actions from ${skillId}`,
    version: spec.info?.version ?? "1.0.0",
    kind: "conversation",
    category: "integration",
    author: { name: "openapi-import" },
    tags: ["openapi", "gpt-action", "imported"],
    runtime: {
      kind: "node",
      entrypoint: "index.mjs",
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
    requirements: { bins: [], env: buildAuthEnvVars(authInfo), config: [], os: ["darwin", "linux", "win32"] },
    inputs: allInputs,
    outputs: [
      { key: "status", type: "number", description: "HTTP response status code" },
      { key: "headers", type: "object", description: "HTTP response headers" },
      { key: "data", type: "object", description: "HTTP response body" },
    ],
    permissions: { grants, promptOn: grants.length > 0 ? ["network.connect"] : [] },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
  };

  const uiSchema = buildOperationUiSchema(manifest);
  const indexMjs = buildCombinedIndexMjs(operations, baseUrl, authInfo);

  const files: FridayConvertedSkillFile[] = [
    { path: "index.mjs", content: indexMjs },
    { path: "skill.manifest.json", content: JSON.stringify(manifest, null, 2) },
    { path: "skill.ui.json", content: JSON.stringify(uiSchema, null, 2) },
  ];

  const conversionReport = {
    sourceFormat: "openai-gpt-action" as const,
    sourceRef: source.uri,
    convertedAt: ctx.nowIso(),
    converterId: CONVERTER_ID,
  };

  files.push({
    path: "conversion.report.json",
    content: JSON.stringify(conversionReport, null, 2),
  });

  return {
    manifest,
    uiSchema,
    files,
    warnings,
    conversionReport,
  };
}

// ─── Manifest builders ───

function extractOperationInputs(op: ExtractedOperation): SkillManifestV2["inputs"] {
  const inputs: SkillManifestV2["inputs"] = [];
  const params = op.operation.parameters ?? [];

  for (const param of params) {
    const schemaType = param.schema?.type ?? "string";

    const input: SkillManifestV2["inputs"][number] = {
      key: param.name,
      type: mapOpenApiType(schemaType),
      required: param.required ?? false,
      label: param.name,
      help: param.description ?? `${param.in} parameter: ${param.name}`,
    };

    if (param.schema?.default !== undefined) {
      input.defaultValue = param.schema.default;
    }

    if (param.schema?.enum && param.schema.enum.length > 0) {
      input.validation = { enum: param.schema.enum };
    }

    inputs.push(input);
  }

  // Extract request body properties
  const requestBody = op.operation.requestBody;
  if (requestBody?.content) {
    const jsonContent = requestBody.content["application/json"];
    if (jsonContent?.schema?.properties) {
      const requiredProps = jsonContent.schema.required ?? [];

      for (const [propName, propSchema] of Object.entries(jsonContent.schema.properties)) {
        inputs.push({
          key: `body_${propName}`,
          type: mapOpenApiType(propSchema.type ?? "string"),
          required: requiredProps.includes(propName),
          label: propName,
          help: propSchema.description ?? `Request body field: ${propName}`,
          ...(propSchema.default !== undefined ? { defaultValue: propSchema.default } : {}),
          ...(propSchema.enum ? { validation: { enum: propSchema.enum } } : {}),
        });
      }
    }
  }

  return inputs;
}

function buildOperationManifest(
  op: ExtractedOperation,
  skillId: string,
  serverHosts: string[],
  authInfo: AuthInfo,
  warnings: string[],
): SkillManifestV2 {
  const inputs = extractOperationInputs(op);

  // Add auth inputs
  const authInputs = buildAuthInputs(authInfo, warnings);
  inputs.push(...authInputs);

  const grants = buildPermissionGrants(serverHosts);

  return {
    schemaVersion: "2.0",
    id: skillId,
    name: op.operation.summary ?? op.operationId,
    description: op.operation.description ?? `${op.method} ${op.path}`,
    version: "1.0.0",
    kind: "conversation",
    category: "integration",
    author: { name: "openapi-import" },
    tags: ["openapi", "gpt-action", "imported"],
    runtime: {
      kind: "node",
      entrypoint: "index.mjs",
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
    requirements: {
      bins: [],
      env: buildAuthEnvVars(authInfo),
      config: [],
      os: ["darwin", "linux", "win32"],
    },
    inputs,
    outputs: [
      { key: "status", type: "number", description: "HTTP response status code" },
      { key: "headers", type: "object", description: "HTTP response headers" },
      { key: "data", type: "object", description: "HTTP response body" },
    ],
    permissions: { grants, promptOn: grants.length > 0 ? ["network.connect"] : [] },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
  };
}

function buildAuthInputs(
  authInfo: AuthInfo,
  warnings: string[],
): SkillManifestV2["inputs"] {
  const inputs: SkillManifestV2["inputs"] = [];

  for (const scheme of authInfo.schemes) {
    if (scheme.type === "apiKey") {
      inputs.push({
        key: `auth_${scheme.name}`,
        type: "secret",
        required: true,
        label: `API Key (${scheme.name})`,
        help: `API key for ${scheme.name} — provide via environment variable or secret input`,
      });
    } else if (scheme.type === "http" && (scheme.scheme === "bearer" || scheme.scheme === "basic")) {
      inputs.push({
        key: `auth_${scheme.name}`,
        type: "secret",
        required: true,
        label: `${scheme.scheme === "bearer" ? "Bearer Token" : "Basic Auth"} (${scheme.name})`,
        help: `${scheme.scheme === "bearer" ? "Bearer token" : "Basic auth credentials"} — provide via environment variable or secret input`,
      });
    } else if (scheme.type === "oauth2") {
      // Already warned about in extractAuthInfo
      inputs.push({
        key: `auth_${scheme.name}`,
        type: "secret",
        required: false,
        label: `OAuth2 Token (${scheme.name})`,
        help: "OAuth2 — requires manual setup. Provide access token if available.",
      });
    }
  }

  return inputs;
}

function buildAuthEnvVars(authInfo: AuthInfo): string[] {
  return authInfo.schemes.map((s) => `AUTH_${s.name.toUpperCase()}`);
}

function buildPermissionGrants(serverHosts: string[]): SkillManifestV2["permissions"]["grants"] {
  const grants: SkillManifestV2["permissions"]["grants"] = [];

  grants.push({
    id: "network.connect",
    resource: "network",
    action: "connect",
    required: true,
    reason: "OpenAPI action performs HTTP requests",
    ...(serverHosts.length > 0
      ? { selectors: { hostAllowlist: serverHosts } }
      : {}),
  });

  return grants;
}

// ─── UI schema builder ───

function buildOperationUiSchema(manifest: SkillManifestV2): FridaySkillUiSchemaV1 {
  const fields: FridaySkillUiSchemaV1["fields"] = [];
  const fieldIds: string[] = [];

  for (const input of manifest.inputs) {
    const fieldId = `field-${input.key}`;
    fieldIds.push(fieldId);

    let kind: FridaySkillUiSchemaV1["fields"][number]["kind"];
    if (input.validation?.enum) {
      kind = "select";
    } else if (input.type === "number") {
      kind = "number";
    } else if (input.type === "boolean") {
      kind = "toggle";
    } else if (input.type === "object") {
      kind = "json";
    } else {
      kind = "text";
    }

    fields.push({
      id: fieldId,
      inputKey: input.key,
      kind,
      label: input.label,
      required: input.required,
      help: input.help,
      placeholder: `Enter ${input.label.toLowerCase()}…`,
      validation: input.validation,
    });
  }

  return {
    schemaVersion: "1.0",
    title: manifest.name,
    description: manifest.description || undefined,
    sections: [
      {
        id: "main",
        label: "Configuration",
        fieldIds,
      },
    ],
    fields,
    outputs: manifest.outputs.map((o) => ({
      id: `output-${o.key}`,
      outputKey: o.key,
      label: o.description ?? o.key,
      widget: o.type === "object" ? "json" as const : "text" as const,
    })),
    actions: [
      { id: "run", label: "Run", style: "primary" },
      { id: "reset", label: "Reset", style: "secondary" },
    ],
  };
}

// ─── Index.mjs builders ───

function buildOperationIndexMjs(
  op: ExtractedOperation,
  baseUrl: string,
  authInfo: AuthInfo,
): string {
  return `/**
 * Friday HTTP executor for: ${op.method} ${op.path}
 * Auto-generated by friday-openai-gpt-action-converter.
 */

export default async function execute(context) {
  const { inputs, env } = context;

  try {
    // Build URL with path parameters
    let url = ${JSON.stringify(baseUrl + op.path)};
    ${buildPathParamSubstitution(op)}

    // Build query parameters
    const queryParams = new URLSearchParams();
    ${buildQueryParamCode(op)}
    ${buildAuthQueryCode(authInfo)}

    const queryString = queryParams.toString();
    if (queryString) {
      url += "?" + queryString;
    }

    // Build headers
    const headers = { "Content-Type": "application/json" };
    ${buildAuthHeaderCode(authInfo)}
    ${buildHeaderParamCode(op)}

    // Build cookie header
    ${buildAuthCookieCode(authInfo)}

    // Build request body
    ${buildBodyCode(op)}

    const response = await fetch(url, {
      method: ${JSON.stringify(op.method)},
      headers,
      ${op.method !== "GET" && op.method !== "HEAD" ? "body: body ? JSON.stringify(body) : undefined," : ""}
    });

    let data;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      data,
    };
  } catch (err) {
    return {
      status: 0,
      headers: {},
      data: { error: err.message },
    };
  }
}
`;
}

function buildCombinedIndexMjs(
  operations: ExtractedOperation[],
  baseUrl: string,
  authInfo: AuthInfo,
): string {
  // Build per-operation handler functions with full path/query/header/body support
  const operationFunctions = operations.map((op) => {
    return `async function op_${sanitizeJsIdentifier(op.operationId)}(inputs, env) {
  try {
    // Build URL with path parameters
    let url = ${JSON.stringify(baseUrl + op.path)};
    ${buildPathParamSubstitution(op)}

    // Build query parameters
    const queryParams = new URLSearchParams();
    ${buildQueryParamCode(op)}
    ${buildAuthQueryCode(authInfo)}

    const queryString = queryParams.toString();
    if (queryString) {
      url += "?" + queryString;
    }

    // Build headers
    const headers = { "Content-Type": "application/json" };
    ${buildAuthHeaderCode(authInfo)}
    ${buildHeaderParamCode(op)}

    // Build cookie header
    ${buildAuthCookieCode(authInfo)}

    // Build request body
    ${buildBodyCode(op)}

    const response = await fetch(url, {
      method: ${JSON.stringify(op.method)},
      headers,
      ${op.method !== "GET" && op.method !== "HEAD" ? "body: body ? JSON.stringify(body) : undefined," : ""}
    });

    let data;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      data,
    };
  } catch (err) {
    return {
      status: 0,
      headers: {},
      data: { error: err.message },
    };
  }
}`;
  }).join("\n\n");

  const cases = operations.map((op) => {
    return `    case ${JSON.stringify(op.operationId)}:
      return await op_${sanitizeJsIdentifier(op.operationId)}(inputs, env);`;
  }).join("\n");

  return `/**
 * Friday combined HTTP executor for OpenAPI spec.
 * Auto-generated by friday-openai-gpt-action-converter.
 */

export default async function execute(context) {
  const { inputs, env } = context;
  const operation = inputs.operation;

  switch (operation) {
${cases}
    default:
      return { status: 0, headers: {}, data: { error: "Unknown operation: " + operation } };
  }
}

${operationFunctions}
`;
}

// ─── Code generation helpers ───

function buildPathParamSubstitution(op: ExtractedOperation): string {
  const pathParams = (op.operation.parameters ?? []).filter((p) => p.in === "path");
  if (pathParams.length === 0) {
    return "";
  }

  return pathParams
    .map((p) => `url = url.replace("{${p.name}}", encodeURIComponent(String(inputs[${JSON.stringify(p.name)}] ?? "")));`)
    .join("\n    ");
}

function buildQueryParamCode(op: ExtractedOperation): string {
  const queryParams = (op.operation.parameters ?? []).filter((p) => p.in === "query");
  if (queryParams.length === 0) {
    return "";
  }

  return queryParams
    .map((p) => `if (inputs[${JSON.stringify(p.name)}] !== undefined) queryParams.set(${JSON.stringify(p.name)}, String(inputs[${JSON.stringify(p.name)}]));`)
    .join("\n    ");
}

function buildHeaderParamCode(op: ExtractedOperation): string {
  const headerParams = (op.operation.parameters ?? []).filter((p) => p.in === "header");
  if (headerParams.length === 0) {
    return "";
  }

  return headerParams
    .map((p) => `if (inputs[${JSON.stringify(p.name)}] !== undefined) headers[${JSON.stringify(p.name)}] = String(inputs[${JSON.stringify(p.name)}]);`)
    .join("\n    ");
}

function buildBodyCode(op: ExtractedOperation): string {
  if (op.method === "GET" || op.method === "HEAD") {
    return "const body = undefined;";
  }

  const requestBody = op.operation.requestBody;
  if (!requestBody?.content?.["application/json"]?.schema?.properties) {
    return "const body = undefined;";
  }

  const props = Object.keys(requestBody.content["application/json"].schema.properties);
  const assignments = props
    .map((p) => `      ${JSON.stringify(p)}: inputs[${JSON.stringify(`body_${p}`)}],`)
    .join("\n");

  return `const body = {
${assignments}
    };`;
}

function buildAuthHeaderCode(authInfo: AuthInfo): string {
  const lines: string[] = [];

  for (const scheme of authInfo.schemes) {
    if (scheme.type === "apiKey" && scheme.inLocation === "header" && scheme.headerName) {
      lines.push(`if (inputs.auth_${scheme.name} || env.AUTH_${scheme.name.toUpperCase()}) headers[${JSON.stringify(scheme.headerName)}] = inputs.auth_${scheme.name} ?? env.AUTH_${scheme.name.toUpperCase()};`);
    } else if (scheme.type === "http" && scheme.scheme === "bearer") {
      lines.push(`if (inputs.auth_${scheme.name} || env.AUTH_${scheme.name.toUpperCase()}) headers["Authorization"] = "Bearer " + (inputs.auth_${scheme.name} ?? env.AUTH_${scheme.name.toUpperCase()});`);
    } else if (scheme.type === "http" && scheme.scheme === "basic") {
      lines.push(`if (inputs.auth_${scheme.name} || env.AUTH_${scheme.name.toUpperCase()}) headers["Authorization"] = "Basic " + (inputs.auth_${scheme.name} ?? env.AUTH_${scheme.name.toUpperCase()});`);
    } else if (scheme.type === "oauth2") {
      lines.push(`if (inputs.auth_${scheme.name} || env.AUTH_${scheme.name.toUpperCase()}) headers["Authorization"] = "Bearer " + (inputs.auth_${scheme.name} ?? env.AUTH_${scheme.name.toUpperCase()});`);
    }
  }

  return lines.join("\n    ");
}

function buildAuthQueryCode(authInfo: AuthInfo): string {
  const lines: string[] = [];

  for (const scheme of authInfo.schemes) {
    if (scheme.type === "apiKey" && scheme.inLocation === "query" && scheme.headerName) {
      lines.push(`if (inputs.auth_${scheme.name} || env.AUTH_${scheme.name.toUpperCase()}) queryParams.set(${JSON.stringify(scheme.headerName)}, inputs.auth_${scheme.name} ?? env.AUTH_${scheme.name.toUpperCase()});`);
    }
  }

  return lines.join("\n    ");
}

function buildAuthCookieCode(authInfo: AuthInfo): string {
  const lines: string[] = [];

  for (const scheme of authInfo.schemes) {
    if (scheme.type === "apiKey" && scheme.inLocation === "cookie" && scheme.headerName) {
      lines.push(`if (inputs.auth_${scheme.name} || env.AUTH_${scheme.name.toUpperCase()}) headers["Cookie"] = (headers["Cookie"] ? headers["Cookie"] + "; " : "") + ${JSON.stringify(scheme.headerName + "=")} + (inputs.auth_${scheme.name} ?? env.AUTH_${scheme.name.toUpperCase()});`);
    }
  }

  return lines.join("\n    ");
}

// ─── Type mapping ───

function mapOpenApiType(type: string): "string" | "number" | "boolean" | "object" | "array" {
  switch (type) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    case "array":
      return "array";
    default:
      return "string";
  }
}
