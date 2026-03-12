export { FridayDomainError } from "./friday-domain-error.js";

// ─── Canonical error-code catalog ───
export {
  FRIDAY_ERROR_CODES,
  buildFridayErrorShape,
  mapFridayErrorToHttpStatus,
  mapFridayErrorToWsCloseCode,
  mapFridayErrorToGrpcStatus,
  FridayErrorShapeSchema,
  validateFridayErrorShape,
} from "./friday-error-codes.js";
export type { FridayErrorCode, FridayErrorShape } from "./friday-error-codes.js";
