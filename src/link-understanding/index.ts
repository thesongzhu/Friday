// ─── Link Understanding — URL Detection, Fetch, and Summarization ───

export {
  DEFAULT_LINK_UNDERSTANDING_CONFIG,
} from "./friday-link-understanding.types.js";

export type {
  FridayLinkCandidate,
  FridayLinkSummary,
  FridayLinkUnderstandingConfig,
  FridayLinkCacheEntry,
  FridayLinkCacheRepository,
} from "./friday-link-understanding.types.js";

export { detectLinks, normalizeUrl } from "./friday-link-detect.js";

export { fetchLink } from "./friday-link-fetch.js";
export type { FridayLinkFetchResult, FridayLinkFetchFn } from "./friday-link-fetch.js";

export { stripHtmlToText, truncateToLength, summarizeContent, extractReadableContent } from "./friday-link-summarize.js";

export { createFridayLinkCacheRepository } from "./friday-link-cache-repository.js";

export { createFridayLinkUnderstandingService } from "./friday-link-understanding-service.js";
export type {
  FridayLinkUnderstandingServiceDeps,
  FridayLinkUnderstandingService,
} from "./friday-link-understanding-service.js";
