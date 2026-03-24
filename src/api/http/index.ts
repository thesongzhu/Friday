// ─── HTTP barrel exports ───

export {
  createFridayHttpRouteRegistry,
  type FridayHttpRouteRegistry,
  type FridayRouteEntry,
} from "./friday-http-route-registry.js";
export {
  FRIDAY_ROUTE_OPERATION_ID_RENAMES,
  FRIDAY_ROUTE_OPERATION_ID_PATTERN,
  isFridayCanonicalRouteOperationId,
} from "./friday-http-route-contract.js";
export type {
  FridayRenamedOperationId,
  FridayCanonicalRenamedOperationId,
} from "./friday-http-route-contract.js";

export {
  buildErrorResponse,
  mapErrorToStatusCode,
  mapErrorToApiError,
} from "./friday-http-error-mapper.js";

export {
  createFridayHttpServer,
  type FridayHttpServer,
  type FridayHttpServerDeps,
} from "./friday-http-server.js";
export {
  parseFridayHttpTrustProxyMode,
  resolveFridayClientIp,
  normalizeFridayClientIp,
  isFridayLoopbackAddress,
  isFridayPrivateNetworkAddress,
  type FridayHttpTrustProxyMode,
} from "./friday-http-client-ip.js";
