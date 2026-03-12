// ─── Anti-detection utilities for Xiaohongshu browser automation ───

// ─── Constants ───

const MIN_ACTION_DELAY_MS = 800;
const MAX_ACTION_DELAY_MS = 2500;
const MIN_VIEWPORT_WIDTH = 1280;
const MAX_VIEWPORT_WIDTH = 1536;
const MIN_VIEWPORT_HEIGHT = 800;
const MAX_VIEWPORT_HEIGHT = 960;

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
] as const;

// ─── Types ───

export interface XhsStealthConfig {
  minDelayMs: number;
  maxDelayMs: number;
  userAgent: string;
  viewportWidth: number;
  viewportHeight: number;
}

export interface XhsStealthScripts {
  /** Script to inject into page to override navigator.webdriver. */
  webdriverOverride: string;
}

// ─── Helpers ───

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Public API ───

/** Generate a random action delay within the configured range. */
export function xhsRandomDelay(
  min: number = MIN_ACTION_DELAY_MS,
  max: number = MAX_ACTION_DELAY_MS,
): number {
  return randomInt(min, max);
}

/** Sleep for a random human-like duration. */
export function xhsSleep(
  min: number = MIN_ACTION_DELAY_MS,
  max: number = MAX_ACTION_DELAY_MS,
): Promise<void> {
  const ms = xhsRandomDelay(min, max);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pick a random realistic user-agent string. */
export function xhsRandomUserAgent(): string {
  return USER_AGENTS[randomInt(0, USER_AGENTS.length - 1)]!;
}

/** Generate a randomized viewport size within reasonable bounds. */
export function xhsRandomViewport(): { width: number; height: number } {
  return {
    width: randomInt(MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH),
    height: randomInt(MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT),
  };
}

/** Build a full stealth config with randomized values. */
export function xhsBuildStealthConfig(): XhsStealthConfig {
  const viewport = xhsRandomViewport();
  return {
    minDelayMs: MIN_ACTION_DELAY_MS,
    maxDelayMs: MAX_ACTION_DELAY_MS,
    userAgent: xhsRandomUserAgent(),
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  };
}

/** Get anti-detection scripts to inject into pages. */
export function xhsStealthScripts(): XhsStealthScripts {
  return {
    webdriverOverride: `
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
      window.chrome = { runtime: {} };
    `,
  };
}

// ─── Exported constants for testing ───

export const XHS_STEALTH_CONSTANTS = {
  MIN_ACTION_DELAY_MS,
  MAX_ACTION_DELAY_MS,
  MIN_VIEWPORT_WIDTH,
  MAX_VIEWPORT_WIDTH,
  MIN_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_HEIGHT,
  USER_AGENTS,
} as const;
