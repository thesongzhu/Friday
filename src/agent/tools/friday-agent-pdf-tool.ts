import * as fs from "node:fs";
import * as path from "node:path";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
  truncateOutput,
} from "./friday-agent-tool-helpers.js";

// ─── Constants ───

const MAX_EXTRACT_BYTES = 100_000; // 100KB text output limit

// ─── Types ───

export type FridayPdfExtractFn = (
  filePath: string,
  options: { pages?: string; signal: AbortSignal },
) => Promise<FridayPdfExtractResult>;

export interface FridayPdfExtractResult {
  text: string;
  pageCount: number;
  metadata?: Record<string, unknown>;
}

export type FridayPdfGenerateFn = (
  content: string,
  options: { format: "html" | "markdown"; outputPath: string; signal: AbortSignal },
) => Promise<FridayPdfGenerateResult>;

export interface FridayPdfGenerateResult {
  filePath: string;
  bytes: number;
  pageCount: number;
}

export interface CreateFridayAgentPdfToolOptions {
  /** Function to extract text from PDF files. */
  extractFn: FridayPdfExtractFn;
  /** Function to generate PDF from HTML/Markdown (optional). */
  generateFn?: FridayPdfGenerateFn;
  /** Workspace root for path resolution. */
  workspaceRoot?: string;
  /** Output directory for generated PDFs. */
  outputDir?: string;
}

// ─── Factory ───

export function createFridayAgentPdfTool(
  options: CreateFridayAgentPdfToolOptions,
): FridayAgentToolDefinition {
  const { extractFn, generateFn, workspaceRoot, outputDir } = options;

  return {
    name: "pdf_process",
    description:
      "Process PDF files. Operations: " +
      "'extract_text' extracts text content from a PDF file, " +
      "'info' returns PDF metadata (page count, etc.)" +
      (generateFn ? ", 'generate' creates a PDF from HTML or Markdown content" : "") +
      ". Text output is truncated to 100KB.",
    parameters: {
      properties: {
        operation: {
          type: "string",
          enum: generateFn
            ? ["extract_text", "info", "generate"]
            : ["extract_text", "info"],
          description: "The PDF operation to perform.",
        },
        filePath: {
          type: "string",
          description: "Path to the PDF file (for extract_text and info operations).",
        },
        pages: {
          type: "string",
          description: "Page range to extract, e.g. '1-5', '3', '10-20' (optional, default: all).",
        },
        content: {
          type: "string",
          description: "HTML or Markdown content to convert to PDF (for generate operation).",
        },
        format: {
          type: "string",
          enum: ["html", "markdown"],
          description: "Content format for generation (default: markdown).",
        },
      },
      required: ["operation"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const operation = readStringParam(args, "operation", { required: true });
      const filePath = readStringParam(args, "filePath");
      const pages = readStringParam(args, "pages");
      const content = readStringParam(args, "content");
      const format = readStringParam(args, "format");

      try {
        switch (operation) {
          case "extract_text": {
            if (!filePath) {
              return errorResult("'filePath' is required for extract_text.");
            }
            const resolved = resolvePath(filePath, workspaceRoot);
            if (!fs.existsSync(resolved)) {
              return errorResult(`File not found: ${resolved}`);
            }
            const result = await extractFn(resolved, { pages, signal });
            const truncated = truncateOutput(result.text, MAX_EXTRACT_BYTES);
            return jsonResult({
              text: truncated,
              pageCount: result.pageCount,
              truncated: truncated !== result.text,
              ...(result.metadata ? { metadata: result.metadata } : {}),
            });
          }

          case "info": {
            if (!filePath) {
              return errorResult("'filePath' is required for info.");
            }
            const resolved = resolvePath(filePath, workspaceRoot);
            if (!fs.existsSync(resolved)) {
              return errorResult(`File not found: ${resolved}`);
            }
            // Extract with empty text just to get metadata
            const result = await extractFn(resolved, { pages: "1", signal });
            return jsonResult({
              filePath: resolved,
              pageCount: result.pageCount,
              ...(result.metadata ? { metadata: result.metadata } : {}),
            });
          }

          case "generate": {
            if (!generateFn) {
              return errorResult("PDF generation is not available.");
            }
            if (!content) {
              return errorResult("'content' is required for generate.");
            }
            const fmt = (format === "html" ? "html" : "markdown") as "html" | "markdown";
            const outDir = outputDir ?? (workspaceRoot ? path.join(workspaceRoot, ".friday", "artifacts") : "/tmp");
            fs.mkdirSync(outDir, { recursive: true });
            const outputPath = path.join(outDir, `generated-${Date.now()}.pdf`);

            const result = await generateFn(content, { format: fmt, outputPath, signal });
            return jsonResult({
              filePath: result.filePath,
              bytes: result.bytes,
              pageCount: result.pageCount,
            });
          }

          default:
            return errorResult(
              `Unknown operation "${operation}". Valid: extract_text, info${generateFn ? ", generate" : ""}.`,
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("PDF operation aborted.");
        }
        return errorResult(`PDF error: ${message}`);
      }
    },
  };
}

// ─── Helpers ───

function resolvePath(filePath: string, workspaceRoot?: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot ?? process.cwd(), filePath);
}
