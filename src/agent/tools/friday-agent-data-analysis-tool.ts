import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readStringParam,
  truncateOutput,
} from "./friday-agent-tool-helpers.js";

// ─── Constants ───

const MAX_OUTPUT_BYTES = 100_000;

// ─── Types ───

export interface FridayDataAnalysisService {
  analyze(data: string, format: string, signal: AbortSignal): Promise<FridayDataAnalysisSummary>;
  transform(data: string, format: string, expression: string, signal: AbortSignal): Promise<string>;
}

export interface FridayDataAnalysisSummary {
  rowCount: number;
  columnCount: number;
  columns: FridayDataColumnSummary[];
  sampleRows: Record<string, unknown>[];
}

export interface FridayDataColumnSummary {
  name: string;
  type: "numeric" | "string" | "date" | "boolean" | "mixed";
  nonNull: number;
  unique: number;
  min?: number | string;
  max?: number | string;
  mean?: number;
  median?: number;
}

export interface CreateFridayAgentDataAnalysisToolOptions {
  dataAnalysisService: FridayDataAnalysisService;
}

// ─── Factory ───

export function createFridayAgentDataAnalysisTool(
  options: CreateFridayAgentDataAnalysisToolOptions,
): FridayAgentToolDefinition {
  const { dataAnalysisService } = options;

  return {
    name: "data_analysis",
    description:
      "Analyze and transform structured data (CSV, JSON, TSV). " +
      "Operations: 'analyze' provides statistical summary of the data, " +
      "'transform' applies a transformation expression to the data. " +
      "Input data can be provided directly as a string or as a file path.",
    parameters: {
      properties: {
        operation: {
          type: "string",
          enum: ["analyze", "transform"],
          description: "The data analysis operation to perform.",
        },
        data: {
          type: "string",
          description: "The data to analyze (CSV/JSON/TSV string or file path).",
        },
        format: {
          type: "string",
          enum: ["csv", "json", "tsv", "auto"],
          description: "Data format (default: auto-detect).",
        },
        expression: {
          type: "string",
          description:
            "Transformation expression (for transform operation). " +
            "Examples: 'filter(age > 30)', 'sort(name)', 'select(name, age)', 'groupBy(category).count()'.",
        },
      },
      required: ["operation", "data"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const operation = readStringParam(args, "operation", { required: true });
      const data = readStringParam(args, "data", { required: true });
      const format = readStringParam(args, "format") ?? "auto";

      try {
        switch (operation) {
          case "analyze": {
            const summary = await dataAnalysisService.analyze(data, format, signal);
            return jsonResult(summary);
          }

          case "transform": {
            const expression = readStringParam(args, "expression", { required: true });
            const result = await dataAnalysisService.transform(data, format, expression, signal);
            return jsonResult({
              result: truncateOutput(result, MAX_OUTPUT_BYTES),
              truncated: Buffer.byteLength(result, "utf8") > MAX_OUTPUT_BYTES,
            });
          }

          default:
            return errorResult(
              `Unknown operation "${operation}". Valid: analyze, transform.`,
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Data analysis aborted.");
        }
        return errorResult(`Data analysis error: ${message}`);
      }
    },
  };
}
