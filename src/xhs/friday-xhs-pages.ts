// ─── XHS Page Interactions — browser automation sequences ───

import { type FridayBrowserManager, sanitizeArtifactPathSegment } from "#browser";
import type { FridayDomDocumentLike, FridayDomElementLike, FridayDomWindowLike } from "#browser";
import type { XhsCookie, XhsSessionManager } from "./friday-xhs-session.js";
import { xhsBuildStealthConfig, xhsSleep, xhsStealthScripts } from "./friday-xhs-stealth.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ───

export interface XhsSearchResult {
  title: string;
  author: string;
  likes: string;
  link: string;
}

export interface XhsComment {
  author: string;
  content: string;
  likes: string;
}

export interface XhsLoginResult {
  status: "authenticated" | "pending_scan" | "timeout" | "error";
  qrScreenshotPath?: string;
  message?: string;
}

export interface XhsPostResult {
  status: "published" | "error";
  noteUrl?: string;
  message?: string;
}

export interface XhsPageInteractions {
  login(sessionId: string, accountName: string, signal?: AbortSignal): Promise<XhsLoginResult>;
  search(sessionId: string, keyword: string, maxResults: number, signal?: AbortSignal): Promise<XhsSearchResult[]>;
  createPost(
    sessionId: string,
    title: string,
    content: string,
    images: string[],
    tags: string[],
    signal?: AbortSignal,
  ): Promise<XhsPostResult>;
  extractComments(sessionId: string, postUrl: string, signal?: AbortSignal): Promise<XhsComment[]>;
  checkLoginState(sessionId: string, signal?: AbortSignal): Promise<boolean>;
}

// DOM-lite types imported from #browser (FridayDomElementLike, FridayDomDocumentLike, FridayDomWindowLike)

export interface CreateXhsPageInteractionsDeps {
  browserManager: FridayBrowserManager;
  sessionManager: XhsSessionManager;
  artifactDir: string;
}

// ─── Constants ───

const XHS_BASE_URL = "https://www.xiaohongshu.com";
const XHS_SEARCH_URL = `${XHS_BASE_URL}/search_result`;
const XHS_CREATOR_URL = "https://creator.xiaohongshu.com/publish/publish";
const LOGIN_POLL_INTERVAL_MS = 3000;
const LOGIN_TIMEOUT_MS = 120_000;

// ─── Factory ───

export function createXhsPageInteractions(deps: CreateXhsPageInteractionsDeps): XhsPageInteractions {
  const { browserManager, sessionManager, artifactDir } = deps;

  async function ensureSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    const { reused } = await browserManager.launch(sessionId, signal);
    if (!reused) {
      const stealthConfig = xhsBuildStealthConfig();
      const { page } = await browserManager.getPage(sessionId, undefined, signal);
      await page.setViewportSize({
        width: stealthConfig.viewportWidth,
        height: stealthConfig.viewportHeight,
      });
    }
  }

  async function injectStealth(sessionId: string, signal?: AbortSignal): Promise<void> {
    const { page } = await browserManager.getPage(sessionId, undefined, signal);
    const scripts = xhsStealthScripts();
    await page.addInitScript(scripts.webdriverOverride);
  }

  async function restoreCookies(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    const cookies = sessionManager.loadCookies(sessionId);
    if (!cookies || cookies.length === 0) return false;

    const { page } = await browserManager.getPage(sessionId, undefined, signal);
    const context = page.context();
    await context.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })),
    );
    return true;
  }

  async function saveBrowserCookies(sessionId: string, accountName: string, signal?: AbortSignal): Promise<void> {
    const { page } = await browserManager.getPage(sessionId, undefined, signal);
    const context = page.context();
    const browserCookies = await context.cookies();
    const xhsCookies: XhsCookie[] = browserCookies
      .filter((c) => c.domain.includes("xiaohongshu"))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite as XhsCookie["sameSite"],
      }));
    sessionManager.saveCookies(sessionId, accountName, xhsCookies);
  }

  // ─── Login flow ───

  async function login(
    sessionId: string,
    accountName: string,
    signal?: AbortSignal,
  ): Promise<XhsLoginResult> {
    await ensureSession(sessionId, signal);
    await injectStealth(sessionId, signal);
    await restoreCookies(sessionId, signal);

    const { page } = await browserManager.getPage(sessionId, undefined, signal);
    await page.goto(XHS_BASE_URL, { waitUntil: "load" });
    await xhsSleep();

    // Check if already logged in
    const isLoggedIn = await detectLoginState(page);
    if (isLoggedIn) {
      await saveBrowserCookies(sessionId, accountName, signal);
      return { status: "authenticated", message: "Already logged in" };
    }

    // Trigger login modal — click the login entry (using locator API)
    const loginTextButton = page.getByText("登录", { exact: true }).first();
    if (await loginTextButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await loginTextButton.click();
    } else {
      const loginFallback = page.locator('[class*="login"]').first();
      if (await loginFallback.isVisible({ timeout: 3000 }).catch(() => false)) {
        await loginFallback.click();
      }
    }
    await xhsSleep();

    // Take QR code screenshot — mkdir with validated artifact dir
    fs.mkdirSync(artifactDir, { recursive: true }); // eslint-disable-line security/detect-non-literal-fs-filename -- artifactDir is internal config, not user input
    let safeSessionId: string;
    try {
      safeSessionId = sanitizeArtifactPathSegment(sessionId);
    } catch (err) {
      console.warn("[friday][xhs-pages] invalid sessionId for artifact path:", err instanceof Error ? err.message : String(err));
      return { status: "error", message: "Invalid sessionId for artifact path." };
    }
    const qrPath = path.join(artifactDir, `xhs-qr-${safeSessionId}-${Date.now()}.png`);
    const screenshotBuffer = await page.screenshot({ type: "png" });
    fs.writeFileSync(qrPath, screenshotBuffer); // eslint-disable-line security/detect-non-literal-fs-filename -- path built from sanitized segments

    // Poll for login completion
    const startTime = Date.now();
    while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_INTERVAL_MS));

      const loggedIn = await detectLoginState(page);
      if (loggedIn) {
        await saveBrowserCookies(sessionId, accountName, signal);
        return { status: "authenticated", message: "Login successful via QR code" };
      }
    }

    return {
      status: "timeout",
      qrScreenshotPath: qrPath,
      message: "Login timed out waiting for QR code scan",
    };
  }

  // ─── Search ───

  async function search(
    sessionId: string,
    keyword: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<XhsSearchResult[]> {
    await ensureSession(sessionId, signal);
    await injectStealth(sessionId, signal);
    await restoreCookies(sessionId, signal);

    const { page } = await browserManager.getPage(sessionId, undefined, signal);
    const searchUrl = `${XHS_SEARCH_URL}?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
    await page.goto(searchUrl, { waitUntil: "load" });
    await xhsSleep(1500, 3000);

    // Extract search result cards from the page
    const results = await page.evaluate((limit: number) => {
      const { document: browserDocument } = globalThis as unknown as { document: FridayDomDocumentLike };
      const cards = Array.from(
        browserDocument.querySelectorAll('[class*="note-item"], section.note-item, a[href*="/explore/"]'),
      ).slice(0, limit);
      const extracted: Array<{ title: string; author: string; likes: string; link: string }> = [];

      for (const card of cards) {
        const titleEl = card.querySelector?.('[class*="title"], h3, .note-title') ?? null;
        const authorEl = card.querySelector?.('[class*="author"], .author-name, [class*="name"]') ?? null;
        const likesEl = card.querySelector?.('[class*="like"], .like-count, [class*="count"]') ?? null;
        const linkEl = card.closest?.("a") ?? card.querySelector?.("a") ?? null;

        extracted.push({
          title: titleEl?.textContent?.trim() ?? "",
          author: authorEl?.textContent?.trim() ?? "",
          likes: likesEl?.textContent?.trim() ?? "0",
          link: linkEl?.getAttribute?.("href") ?? "",
        });
      }

      return extracted;
    }, maxResults);

    sessionManager.touchSession(sessionId);
    return results;
  }

  // ─── Post creation ───

  async function createPost(
    sessionId: string,
    title: string,
    content: string,
    images: string[],
    tags: string[],
    signal?: AbortSignal,
  ): Promise<XhsPostResult> {
    await ensureSession(sessionId, signal);
    await injectStealth(sessionId, signal);
    const hasCookies = await restoreCookies(sessionId, signal);
    if (!hasCookies) {
      return { status: "error", message: "No session cookies found. Login first." };
    }

    const { page } = await browserManager.getPage(sessionId, undefined, signal);
    await page.goto(XHS_CREATOR_URL, { waitUntil: "load" });
    await xhsSleep(2000, 4000);

    // Upload images via file input
    try {
      const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 10_000 });
      if (fileInput) {
        await fileInput.setInputFiles(images);
        await xhsSleep(2000, 4000);
      }
    } catch (err) {
      console.warn("[friday][xhs-pages] image upload input not found:", err instanceof Error ? err.message : String(err));
      return { status: "error", message: "Failed to find image upload input" };
    }

    // Fill title
    try {
      const titleInput = await page.waitForSelector(
        '[placeholder*="标题"], #post-title, [class*="title"] input, [class*="title"] textarea',
        { timeout: 5000 },
      );
      if (titleInput) {
        await titleInput.fill(title);
        await xhsSleep();
      }
    } catch (err) {
      console.warn("[friday][xhs-pages] title input not found:", err instanceof Error ? err.message : String(err));
      return { status: "error", message: "Failed to find title input" };
    }

    // Fill content
    try {
      const contentInput = await page.waitForSelector(
        '[placeholder*="正文"], #post-content, [class*="content"] [contenteditable], [class*="ql-editor"]',
        { timeout: 5000 },
      );
      if (contentInput) {
        await contentInput.fill(content);
        await xhsSleep();
      }
    } catch (err) {
      console.warn("[friday][xhs-pages] content input not found:", err instanceof Error ? err.message : String(err));
      return { status: "error", message: "Failed to find content input" };
    }

    // Add tags
    for (const tag of tags) {
      try {
        await page.keyboard.type(`#${tag} `, { delay: 50 });
        await xhsSleep(500, 1000);
        await page.keyboard.press("Enter");
        await xhsSleep(300, 600);
      } catch (err) {
        // Tag input may not be available, continue
        console.warn("[friday][xhs-pages] tag input failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // Click publish (using locator API)
    try {
      const publishBtn = page.getByRole("button", { name: /^(发布|Publish)$/ }).first();
      await publishBtn.click({ timeout: 5000 });
      await xhsSleep(3000, 5000);
    } catch (err) {
      console.warn("[friday][xhs-pages] publish button not found:", err instanceof Error ? err.message : String(err));
      return { status: "error", message: "Failed to find publish button" };
    }

    const currentUrl = page.url();
    sessionManager.touchSession(sessionId);

    return {
      status: "published",
      noteUrl: currentUrl,
      message: "Post published successfully",
    };
  }

  // ─── Comments extraction ───

  async function extractComments(
    sessionId: string,
    postUrl: string,
    signal?: AbortSignal,
  ): Promise<XhsComment[]> {
    await ensureSession(sessionId, signal);
    await injectStealth(sessionId, signal);
    await restoreCookies(sessionId, signal);

    const { page } = await browserManager.getPage(sessionId, undefined, signal);
    await page.goto(postUrl, { waitUntil: "load" });
    await xhsSleep(2000, 3500);

    // Scroll to load comments
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const { window: browserWindow } = globalThis as unknown as { window: FridayDomWindowLike };
        browserWindow.scrollBy(0, 500);
      });
      await xhsSleep(800, 1500);
    }

    // Extract comments
    const comments = await page.evaluate(() => {
      const { document: browserDocument } = globalThis as unknown as { document: FridayDomDocumentLike };
      const commentEls = Array.from(
        browserDocument.querySelectorAll('[class*="comment-item"], [class*="comment-inner"], .comment'),
      );
      const extracted: Array<{ author: string; content: string; likes: string }> = [];

      for (const el of commentEls) {
        const authorEl = el.querySelector?.('[class*="name"], .author, [class*="user"]') ?? null;
        const contentEl = el.querySelector?.('[class*="content"], .comment-text, p') ?? null;
        const likesEl = el.querySelector?.('[class*="like"], .like-count, [class*="count"]') ?? null;

        extracted.push({
          author: authorEl?.textContent?.trim() ?? "",
          content: contentEl?.textContent?.trim() ?? "",
          likes: likesEl?.textContent?.trim() ?? "0",
        });
      }

      return extracted;
    });

    sessionManager.touchSession(sessionId);
    return comments;
  }

  // ─── Login state detection ───

  async function checkLoginState(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    await ensureSession(sessionId, signal);
    await restoreCookies(sessionId, signal);

    const { page } = await browserManager.getPage(sessionId, undefined, signal);
    await page.goto(XHS_BASE_URL, { waitUntil: "load" });
    await xhsSleep(1000, 2000);

    return await detectLoginState(page);
  }

  return {
    login,
    search,
    createPost,
    extractComments,
    checkLoginState,
  };
}

// ─── Internal helpers ───

async function detectLoginState(page: { evaluate: (fn: () => unknown) => Promise<unknown> }): Promise<boolean> {
  return (await page.evaluate(() => {
    const { document: browserDocument } = globalThis as unknown as { document: FridayDomDocumentLike };
    const hasAvatar = browserDocument.querySelector('[class*="avatar"], [class*="user-avatar"]') !== null;
    const hasLoginBtn = Array.from(
      browserDocument.querySelectorAll('button, a, [role="button"], span, div'),
    ).some((el: FridayDomElementLike) => el.textContent?.trim() === "登录");
    const cookies = browserDocument.cookie ?? "";
    const hasSessionCookie = cookies.includes("web_session") || cookies.includes("a1");
    return (hasAvatar || hasSessionCookie) && !hasLoginBtn;
  })) as boolean;
}

// ─── Exported constants ───

export const XHS_PAGE_CONSTANTS = {
  XHS_BASE_URL,
  XHS_SEARCH_URL,
  XHS_CREATOR_URL,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_TIMEOUT_MS,
} as const;
