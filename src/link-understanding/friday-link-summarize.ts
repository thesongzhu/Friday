/**
 * Link Summarize — Extract readable content from HTML using Mozilla Readability.
 *
 * Uses @mozilla/readability + linkedom (same approach as OpenClaw) for
 * intelligent content extraction.  Falls back to regex-based HTML stripping
 * when Readability cannot parse the page.
 *
 * @module link-understanding/friday-link-summarize
 */

// ─── Lazy-loaded Readability deps ───

import type { Readability as ReadabilityType } from "@mozilla/readability";
import type { parseHTML as ParseHTMLType } from "linkedom";

interface ReadabilityDeps {
  Readability: typeof ReadabilityType;
  parseHTML: typeof ParseHTMLType;
}

let readabilityDepsPromise: Promise<ReadabilityDeps> | undefined;

async function loadReadabilityDeps(): Promise<ReadabilityDeps> {
  if (!readabilityDepsPromise) {
    readabilityDepsPromise = Promise.all([
      import("@mozilla/readability"),
      import("linkedom"),
    ]).then(([readability, linkedom]) => ({
      Readability: readability.Readability,
      parseHTML: linkedom.parseHTML,
    }));
  }
  try {
    return await readabilityDepsPromise;
  } catch (error) {
    readabilityDepsPromise = undefined;
    throw error;
  }
}

// ─── Readability extraction ───

/**
 * Extract readable content from HTML using Mozilla Readability.
 * Returns null when Readability cannot extract meaningful content.
 */
export async function extractReadableContent(
  html: string,
  url?: string,
): Promise<{ text: string; title?: string } | null> {
  try {
    const { Readability, parseHTML } = await loadReadabilityDeps();
    const { document } = parseHTML(html);
    if (url && canAssignBaseUri(document)) {
      try {
        (document as { baseURI?: string }).baseURI = url;
      } catch (err) {
        // Best-effort base URI for relative links.
        console.warn("[friday][link-summarize] base URI assignment failed:", err instanceof Error ? err.message : String(err));
      }
    }
    const reader = new Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();
    if (!parsed?.textContent) return null;

    const text = parsed.textContent.replace(/\s+/g, " ").trim();
    return text ? { text, title: parsed.title || undefined } : null;
  } catch (err) {
    console.warn("[friday][link-summarize] HTML extraction failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function canAssignBaseUri(document: object): boolean {
  let current: object | null = document;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "baseURI");
    if (descriptor) {
      return descriptor.writable === true || typeof descriptor.set === "function";
    }
    current = Object.getPrototypeOf(current);
  }
  return true;
}

// ─── Regex fallback ───

/**
 * Strips HTML tags and normalizes whitespace to produce plain text.
 * Used as a fallback when Readability is unavailable or fails.
 */
export function stripHtmlToText(html: string): string {
  // Remove script and style blocks
  let text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  // Remove all tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common entities
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  // Normalize whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

// ─── Truncation ───

/**
 * Truncates text to maxChars, breaking at a word boundary.
 */
export function truncateToLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.7) {
    return truncated.slice(0, lastSpace) + "...";
  }
  return truncated + "...";
}

// ─── Main summarization ───

/**
 * Produces a summary from fetched content.
 *
 * For HTML: uses Readability to extract article text, falls back to regex stripping.
 * For plain text: truncates directly.
 *
 * Detects JS-rendered pages where the HTML shell has very little readable
 * content relative to the raw HTML size (SPA frameworks like React, Vue, etc.).
 */
export async function summarizeContent(
  body: string,
  contentType: string | null,
  maxChars: number,
  url?: string,
): Promise<string> {
  const isHtml = contentType ? contentType.includes("html") : body.trimStart().startsWith("<");

  if (!isHtml) {
    return truncateToLength(body.trim(), maxChars);
  }

  // Try Readability first (same as OpenClaw)
  const readable = await extractReadableContent(body, url);
  if (readable?.text && readable.text.length > 100) {
    // Readability succeeded — return extracted text
    const prefix = readable.title ? `${readable.title}\n\n` : "";
    return truncateToLength(prefix + readable.text, maxChars);
  }

  // Readability failed or returned very little — fall back to regex stripping
  const plainText = stripHtmlToText(body);

  if (plainText.length === 0) {
    return "(Empty page — content may require JavaScript to render. Use browser tool with snapshot action instead.)";
  }

  // Detect JS-rendered pages: large HTML but very little readable text after stripping
  if (body.length > 5_000 && plainText.length < 500) {
    return `(JS-rendered page detected — extracted text is minimal. Use browser tool with snapshot action to read this page.)\n\nExtracted text: ${plainText}`;
  }

  // Detect pages where text is mostly boilerplate navigation
  if (body.length > 10_000 && plainText.length < body.length * 0.02) {
    return `(Page appears to be JS-rendered — very low text-to-HTML ratio. Use browser tool with snapshot action to read this page.)\n\nExtracted text: ${truncateToLength(plainText, 500)}`;
  }

  return truncateToLength(plainText, maxChars);
}
