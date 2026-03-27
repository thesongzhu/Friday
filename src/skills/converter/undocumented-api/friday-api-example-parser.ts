import type {
  FridayApiDocsCorpus,
  FridayApiExampleParseResult,
  FridayParsedApiEndpoint,
} from "./friday-undocumented-api.types.js";

const METHOD_AND_TARGET_REGEX =
  /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+((?:https?:\/\/[^\s"'`]+)|(?:\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%{}-]*))/gi;

export function parseFridayApiExamples(
  corpus: FridayApiDocsCorpus,
): FridayApiExampleParseResult {
  const endpoints = new Map<string, FridayParsedApiEndpoint>();
  const authHints = new Set<"bearer" | "api-key" | "basic">();
  const warnings: string[] = [];

  for (const page of corpus.pages) {
    const content = page.content;
    for (const match of content.matchAll(METHOD_AND_TARGET_REGEX)) {
      const rawMethod = match[1]?.toUpperCase();
      const rawTarget = match[2];
      if (!rawMethod || !rawTarget) continue;

      const method = toMethod(rawMethod);
      if (!method) continue;

      const parsed = normalizeTarget(rawTarget);
      if (!parsed) continue;

      const key = `${method} ${parsed.path}`;
      if (!endpoints.has(key)) {
        endpoints.set(key, {
          method,
          path: parsed.path,
          origin: parsed.origin,
        });
      }
    }

    if (/authorization:\s*bearer\b|bearer\s+token|oauth2?/i.test(content)) {
      authHints.add("bearer");
    }
    if (/x-api-key|api[-_ ]?key|authorization:\s*api[-_ ]?key/i.test(content)) {
      authHints.add("api-key");
    }
    if (/authorization:\s*basic|basic auth/i.test(content)) {
      authHints.add("basic");
    }
  }

  if (endpoints.size === 0) {
    warnings.push("No explicit HTTP method + path signatures found in source content.");
  }

  return {
    endpoints: [...endpoints.values()],
    authHints: [...authHints],
    warnings,
  };
}

function toMethod(value: string): FridayParsedApiEndpoint["method"] | null {
  switch (value) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "HEAD":
    case "OPTIONS":
      return value;
    default:
      return null;
  }
}

function normalizeTarget(target: string): { path: string; origin?: string } | null {
  if (target.startsWith("http://") || target.startsWith("https://")) {
    try {
      const parsed = new URL(target);
      const path = parsed.pathname || "/";
      return { path: path.startsWith("/") ? path : `/${path}`, origin: parsed.origin };
    } catch (err) {
    console.warn("[friday][api-example-parser] operation failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  const path = target.startsWith("/") ? target : `/${target}`;
  return { path };
}

