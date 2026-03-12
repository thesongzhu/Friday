// ─── XHS Module — Xiaohongshu automation ───

// Session manager
export type {
  XhsSessionRow,
  XhsCookie,
  XhsSessionManager,
  CreateXhsSessionManagerDeps,
} from "./friday-xhs-session.js";
export {
  createXhsSessionManager,
  XHS_SESSION_CONSTANTS,
} from "./friday-xhs-session.js";

// Page interactions
export type {
  XhsSearchResult,
  XhsComment,
  XhsLoginResult,
  XhsPostResult,
  XhsPageInteractions,
  CreateXhsPageInteractionsDeps,
} from "./friday-xhs-pages.js";
export {
  createXhsPageInteractions,
  XHS_PAGE_CONSTANTS,
} from "./friday-xhs-pages.js";

// Stealth / anti-detection
export type {
  XhsStealthConfig,
  XhsStealthScripts,
} from "./friday-xhs-stealth.js";
export {
  xhsRandomDelay,
  xhsSleep,
  xhsRandomUserAgent,
  xhsRandomViewport,
  xhsBuildStealthConfig,
  xhsStealthScripts,
  XHS_STEALTH_CONSTANTS,
} from "./friday-xhs-stealth.js";
