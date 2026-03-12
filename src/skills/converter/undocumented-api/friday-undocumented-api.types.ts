export interface FridayApiDocsPage {
  source: string;
  content: string;
  fetchedAt: string;
}

export interface FridayApiDocsCorpus {
  sourceRef: string;
  pages: FridayApiDocsPage[];
}

export interface FridayParsedApiEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  path: string;
  origin?: string;
}

export interface FridayApiExampleParseResult {
  endpoints: FridayParsedApiEndpoint[];
  authHints: Array<"bearer" | "api-key" | "basic">;
  warnings: string[];
}

export interface FridaySynthesizedOpenApi {
  spec: Record<string, unknown>;
  warnings: string[];
}

export interface FridayOpenApiValidationResult {
  ok: boolean;
  issues: string[];
}

