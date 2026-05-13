/**
 * Phase 02b — Social link to capability loop, partial slice.
 *
 * Exports the type contract and the service factory for the partial slice.
 * The slice itself ONLY closes the first half of the module_01 loop
 * (extraction + entity/source mapping + candidate staging via the canonical
 * approval gate). The autonomy shadow / canary / promote / verify chain and
 * the learning emit remain operator-driven through existing routes.
 */

export type {
  FridaySocialImportAcceptedHost,
  FridaySocialImportExtractionShape,
  FridaySocialImportPlanDigestInput,
  FridaySocialImportRequest,
  FridaySocialImportService,
  FridaySocialImportStageContext,
  FridaySocialImportSuccessResponse,
} from "./friday-social-import.types.js";

export {
  FRIDAY_SOCIAL_IMPORT_ACCEPTED_HOSTS,
  FRIDAY_SOCIAL_IMPORT_DEFAULT_NEXT_STEPS,
  FRIDAY_SOCIAL_IMPORT_PLAN_VERSION,
} from "./friday-social-import.types.js";

export type { CreateFridaySocialImportServiceDeps } from "./friday-social-import-service.js";
export { createFridaySocialImportService } from "./friday-social-import-service.js";
