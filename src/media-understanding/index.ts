// ─── Media Understanding — Attachment Extraction Pipeline ───

export {
  DEFAULT_MEDIA_UNDERSTANDING_CONFIG,
} from "./friday-media-understanding.types.js";

export type {
  FridayMediaType,
  FridayMediaAttachment,
  FridayMediaUnderstandingConfig,
  FridayMediaUnderstandingOutput,
  FridayMediaUnderstandingProvider,
  FridayMediaUnderstandingDecision,
  FridayMediaUnderstandingResult,
  FridayMediaEnrichmentBlock,
} from "./friday-media-understanding.types.js";

export {
  detectMediaType,
  buildAttachmentList,
  applyAttachmentPolicy,
} from "./friday-media-attachments.js";
export type { RawAttachmentInput } from "./friday-media-attachments.js";

export { resolveProvider, runProviderChain } from "./friday-media-providers.js";

export { formatEnrichmentBlock, formatContextSection } from "./friday-media-format.js";

export { createFridayMediaUnderstandingService } from "./friday-media-understanding-service.js";
export type {
  FridayMediaUnderstandingServiceDeps,
  FridayMediaUnderstandingService,
} from "./friday-media-understanding-service.js";
