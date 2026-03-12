import type {
  FridayApiDocsCorpus,
  FridayApiExampleParseResult,
  FridayParsedApiEndpoint,
  FridaySynthesizedOpenApi,
} from "./friday-undocumented-api.types.js";

export function synthesizeFridayOpenApi(input: {
  corpus: FridayApiDocsCorpus;
  parsed: FridayApiExampleParseResult;
}): FridaySynthesizedOpenApi {
  const warnings: string[] = [...input.parsed.warnings];
  const title = inferTitle(input.corpus.sourceRef);
  const serverUrl = inferServerUrl(input.parsed.endpoints, input.corpus.sourceRef);

  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of input.parsed.endpoints) {
    const methodKey = endpoint.method.toLowerCase();
    const normalizedPath = normalizePath(endpoint.path);
    if (!paths[normalizedPath]) {
      paths[normalizedPath] = {};
    }
    paths[normalizedPath]![methodKey] = {
      operationId: buildOperationId(endpoint),
      summary: `${endpoint.method} ${normalizedPath}`,
      responses: {
        "200": { description: "Successful response" },
      },
    };
  }

  const securitySchemes = buildSecuritySchemes(input.parsed.authHints);
  if (!serverUrl) {
    warnings.push("No server URL could be inferred from docs. Using placeholder server.");
  }

  const spec: Record<string, unknown> = {
    openapi: "3.0.0",
    info: {
      title,
      version: "1.0.0",
      description: "Synthesized from undocumented API docs/examples.",
    },
    servers: [
      {
        url: serverUrl ?? "https://api.example.com",
      },
    ],
    paths,
  };

  if (securitySchemes.components) {
    spec.components = securitySchemes.components;
  }
  if (securitySchemes.security) {
    spec.security = securitySchemes.security;
  }

  return { spec, warnings };
}

function inferTitle(sourceRef: string): string {
  try {
    if (/^https?:\/\//i.test(sourceRef)) {
      const host = new URL(sourceRef).hostname;
      return `${host} API`;
    }
  } catch {
    // ignore
  }
  const cleaned = sourceRef.split(/[\\/]/).pop() ?? sourceRef;
  return cleaned.length > 0 ? `${cleaned} API` : "Undocumented API";
}

function inferServerUrl(endpoints: FridayParsedApiEndpoint[], sourceRef: string): string | null {
  const fromEndpoint = endpoints.find((e) => e.origin)?.origin;
  if (fromEndpoint) return fromEndpoint;

  if (/^https?:\/\//i.test(sourceRef)) {
    try {
      const parsed = new URL(sourceRef);
      return parsed.origin;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizePath(path: string): string {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function buildOperationId(endpoint: FridayParsedApiEndpoint): string {
  const pathPart = endpoint.path
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `${endpoint.method.toLowerCase()}_${pathPart || "root"}`;
}

function buildSecuritySchemes(authHints: FridayApiExampleParseResult["authHints"]): {
  components?: { securitySchemes: Record<string, unknown> };
  security?: Array<Record<string, string[]>>;
} {
  if (authHints.length === 0) return {};

  const schemes: Record<string, unknown> = {};
  const security: Array<Record<string, string[]>> = [];

  for (const hint of authHints) {
    if (hint === "bearer") {
      schemes["bearerAuth"] = { type: "http", scheme: "bearer" };
      security.push({ bearerAuth: [] });
    } else if (hint === "api-key") {
      schemes["apiKeyAuth"] = { type: "apiKey", in: "header", name: "X-API-Key" };
      security.push({ apiKeyAuth: [] });
    } else if (hint === "basic") {
      schemes["basicAuth"] = { type: "http", scheme: "basic" };
      security.push({ basicAuth: [] });
    }
  }

  return {
    components: { securitySchemes: schemes },
    security,
  };
}

