/**
 * Deep Link Parser — parses `friday://` URIs into structured payloads.
 *
 * URI format: friday://<type>?<params>
 * Or: accepts a JSON payload directly for POST /v1/deeplink/preview.
 *
 * Examples:
 *   friday://provider-template?kind=openai&apiKey=$OPENAI_API_KEY
 *   friday://skill-source?url=https://github.com/user/repo
 *   friday://mcp-server?name=my-server&transport=stdio&command=npx&args=-y,@my/mcp
 */

import type { FridayDeepLinkPayload, FridayDeepLinkResourceType } from "./friday-deeplink-types.js";

const VALID_RESOURCE_TYPES = new Set<FridayDeepLinkResourceType>([
  "provider-template",
  "skill-source",
  "mcp-server",
  "workflow-template",
]);

export type FridayDeepLinkParseResult =
  | { ok: true; payload: FridayDeepLinkPayload }
  | { ok: false; error: string };

export function parseFridayDeepLinkUri(uri: string): FridayDeepLinkParseResult {
  const trimmed = uri.trim();

  if (!trimmed.startsWith("friday://")) {
    return { ok: false, error: "URI must start with friday://" };
  }

  const withoutScheme = trimmed.slice("friday://".length);
  const questionIndex = withoutScheme.indexOf("?");
  const resourceType = (questionIndex >= 0
    ? withoutScheme.slice(0, questionIndex)
    : withoutScheme) as FridayDeepLinkResourceType;

  if (!VALID_RESOURCE_TYPES.has(resourceType)) {
    return { ok: false, error: `Unknown resource type: ${resourceType}` };
  }

  const params = new URLSearchParams(
    questionIndex >= 0 ? withoutScheme.slice(questionIndex + 1) : "",
  );

  const label = params.get("label") ?? `Import ${resourceType}`;
  const source = params.get("source") ?? undefined;
  const integrityHash = params.get("integrity") ?? undefined;

  const payload: FridayDeepLinkPayload = {
    version: 1,
    type: resourceType,
    label,
    source,
    integrityHash,
  };

  switch (resourceType) {
    case "provider-template":
      payload.providerTemplate = {
        providerKind: params.get("kind") ?? "",
        apiKey: params.get("apiKey") ?? undefined,
        baseUrl: params.get("baseUrl") ?? undefined,
        model: params.get("model") ?? undefined,
      };
      break;
    case "skill-source":
      payload.skillSource = {
        url: params.get("url") ?? "",
        ref: params.get("ref") ?? undefined,
        manifestPath: params.get("manifestPath") ?? undefined,
      };
      break;
    case "mcp-server":
      payload.mcpServer = {
        name: params.get("name") ?? "",
        transport: (params.get("transport") ?? "stdio") as "stdio" | "sse" | "streamable-http",
        command: params.get("command") ?? undefined,
        args: params.get("args")?.split(",") ?? undefined,
        url: params.get("url") ?? undefined,
      };
      break;
    case "workflow-template":
      payload.workflowTemplate = {
        url: params.get("url") ?? "",
        name: params.get("name") ?? undefined,
      };
      break;
  }

  return { ok: true, payload };
}

export function parseFridayDeepLinkJson(raw: unknown): FridayDeepLinkParseResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "Payload must be a JSON object" };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) {
    return { ok: false, error: `Unsupported deep link version: ${String(obj.version)}` };
  }

  const type = obj.type as FridayDeepLinkResourceType | undefined;
  if (!type || !VALID_RESOURCE_TYPES.has(type)) {
    return { ok: false, error: `Unknown or missing resource type: ${String(obj.type)}` };
  }

  const label = typeof obj.label === "string" ? obj.label : `Import ${type}`;

  return {
    ok: true,
    payload: {
      version: 1,
      type,
      label,
      source: typeof obj.source === "string" ? obj.source : undefined,
      integrityHash: typeof obj.integrityHash === "string" ? obj.integrityHash : undefined,
      providerTemplate: obj.providerTemplate as FridayDeepLinkPayload["providerTemplate"],
      skillSource: obj.skillSource as FridayDeepLinkPayload["skillSource"],
      mcpServer: obj.mcpServer as FridayDeepLinkPayload["mcpServer"],
      workflowTemplate: obj.workflowTemplate as FridayDeepLinkPayload["workflowTemplate"],
    },
  };
}
