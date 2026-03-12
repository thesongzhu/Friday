export interface FridayHttpRawTextResponse {
  readonly __fridayRawTextResponse: true;
  readonly statusCode: number;
  readonly body: string;
  readonly headers?: Record<string, string>;
  readonly contentType?: string;
}

export function createFridayHttpRawTextResponse(
  body: string,
  options: {
    statusCode?: number;
    headers?: Record<string, string>;
    contentType?: string;
  } = {},
): FridayHttpRawTextResponse {
  return {
    __fridayRawTextResponse: true,
    statusCode: options.statusCode ?? 200,
    body,
    headers: options.headers,
    contentType: options.contentType,
  };
}

export function isFridayHttpRawTextResponse(
  value: unknown,
): value is FridayHttpRawTextResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "__fridayRawTextResponse" in value &&
    (value as { __fridayRawTextResponse?: unknown }).__fridayRawTextResponse === true
  );
}

