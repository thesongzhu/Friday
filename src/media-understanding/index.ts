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

// ─── Phase 02a: doctor + OpenAI vision adapter ───

export {
  probeMediaUnderstandingProvider,
  FRIDAY_MEDIA_DOCTOR_DEFAULT_PNG_BASE64,
  FRIDAY_MEDIA_DOCTOR_DEFAULT_TIMEOUT_MS,
} from "./friday-media-doctor.js";
export type {
  FridayMediaUnderstandingDoctorReport,
  ProbeMediaUnderstandingProviderOptions,
} from "./friday-media-doctor.js";

export {
  createFridayOpenAiVisionProvider,
  FRIDAY_OPENAI_VISION_PROVIDER_ID,
  DEFAULT_OPENAI_VISION_MODEL,
  DEFAULT_OPENAI_VISION_BASE_URL,
} from "./providers/friday-openai-vision-provider.js";
export type { FridayOpenAiVisionProviderConfig } from "./providers/friday-openai-vision-provider.js";
