import * as fsSync from "node:fs";
import * as path from "node:path";

import { FRIDAY_AGENT_READ_MAX_BYTES } from "../friday-agent.constants.js";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import { FridaySafeOpenError, openFileWithinRoot } from "../../utilities/friday-path-safety.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
  truncateOutput,
} from "./friday-agent-tool-helpers.js";

const DEFAULT_MAX_PAGES = 50;
const MAX_ALLOWED_PAGES = 500;
const DEFAULT_MAX_CHARS = FRIDAY_AGENT_READ_MAX_BYTES;
const MAX_ALLOWED_CHARS = 250_000;

interface PdfTextItem {
  str?: unknown;
}

interface PdfTextContent {
  items?: unknown;
}

export interface CreateFridayAgentPdfParseToolOptions {
  workspaceRoot?: string;
}

export function createFridayAgentPdfParseTool(
  options?: CreateFridayAgentPdfParseToolOptions,
): FridayAgentToolDefinition {
  const workspaceRoot = options?.workspaceRoot ?? process.cwd();

  return {
    name: "pdf_parse",
    description:
      "Extract text from a local PDF file inside the workspace. " +
      "Returns page count, extracted page text, and a combined truncated text field.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the PDF file to parse." },
        maxPages: {
          type: "number",
          description: `Maximum pages to parse. Default: ${String(DEFAULT_MAX_PAGES)}.`,
        },
        maxChars: {
          type: "number",
          description: `Maximum combined text characters to return. Default: ${String(DEFAULT_MAX_CHARS)}.`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, signal: AbortSignal): Promise<FridayAgentToolResult> {
      const inputPath = readStringParam(args, "path", { required: true });
      const maxPages = clampInteger(readNumberParam(args, "maxPages", { integer: true }), 1, MAX_ALLOWED_PAGES, DEFAULT_MAX_PAGES);
      const maxChars = clampInteger(readNumberParam(args, "maxChars", { integer: true }), 1_000, MAX_ALLOWED_CHARS, DEFAULT_MAX_CHARS);

      if (path.extname(inputPath).toLowerCase() !== ".pdf") {
        return errorResult(`Path "${inputPath}" is not a PDF file.`);
      }

      const relativePath = path.isAbsolute(inputPath)
        ? path.relative(workspaceRoot, inputPath)
        : inputPath;
      let fd: number;
      let resolvedPath: string;
      try {
        const opened = openFileWithinRoot({ rootDir: workspaceRoot, relativePath });
        fd = opened.fd;
        resolvedPath = opened.resolvedPath;
      } catch (err) {
        if (err instanceof FridaySafeOpenError) {
          return errorResult(err.kind === "not-found"
            ? `PDF file not found: ${inputPath}`
            : `Path "${inputPath}" is not allowed: ${err.message}`);
        }
        return errorResult(`Failed to open PDF: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const bytes = fsSync.readFileSync(fd);
        const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const loadingTask = getDocument({
          data: new Uint8Array(bytes),
          disableFontFace: true,
          isEvalSupported: false,
          useSystemFonts: false,
          verbosity: 0,
        });
        const document = await loadingTask.promise;
        try {
          const pageCount = document.numPages;
          const pages: Array<{ pageNumber: number; text: string }> = [];
          let combined = "";
          const parsePageCount = Math.min(pageCount, maxPages);

          for (let pageNumber = 1; pageNumber <= parsePageCount; pageNumber += 1) {
            signal.throwIfAborted();
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent() as PdfTextContent;
            const text = extractPdfText(content);
            pages.push({ pageNumber, text: truncateOutput(text, maxChars) });
            combined += `${combined ? "\n\n" : ""}--- Page ${String(pageNumber)} ---\n${text}`;
            if (combined.length >= maxChars) {
              break;
            }
          }

          return jsonResult({
            filePath: resolvedPath,
            pageCount,
            parsedPages: pages.length,
            truncated: pageCount > pages.length || combined.length > maxChars,
            text: truncateOutput(combined, maxChars),
            pages,
          });
        } finally {
          await document.destroy().catch(() => undefined);
        }
      } catch (err) {
        if (err instanceof Error && /abort/i.test(err.message)) {
          return errorResult("PDF parsing aborted.");
        }
        return errorResult(`PDF parsing failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        fsSync.closeSync(fd);
      }
    },
  };
}

function extractPdfText(content: PdfTextContent): string {
  const items = Array.isArray(content.items) ? content.items : [];
  return items
    .map((item) => typeof (item as PdfTextItem).str === "string" ? (item as { str: string }).str : "")
    .filter((text) => text.length > 0)
    .join(" ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
