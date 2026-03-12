/**
 * Undocumented API converter.
 *
 * Reads unstructured docs/examples and synthesizes an OpenAPI spec, then
 * delegates to the existing OpenAPI converter for final draft generation.
 */

import { FridayDomainError } from "#errors";

import { createFridayOpenAiGptActionConverter } from "./friday-openai-gpt-action-converter.js";
import type {
  FridayConvertedSkillDraft,
  FridaySkillConversionSource,
  FridaySkillConverter,
  FridaySkillConverterContext,
  FridaySkillConverterDetection,
  FridaySkillConverterResult,
} from "../model/friday-skill-converter.types.js";
import { createFridayApiDocCrawler } from "../undocumented-api/friday-api-doc-crawler.js";
import { parseFridayApiExamples } from "../undocumented-api/friday-api-example-parser.js";
import { synthesizeFridayOpenApi } from "../undocumented-api/friday-openapi-synthesizer.js";
import { validateFridayOpenApi } from "../undocumented-api/friday-openapi-validator.js";

const CONVERTER_ID = "undocumented-api";
const CONVERTER_DISPLAY_NAME = "Undocumented API Analyzer";
const CONVERTER_PRIORITY = 35;

export function createFridayUndocumentedApiConverter(): FridaySkillConverter {
  const delegate = createFridayOpenAiGptActionConverter({
    splitOperations: true,
  });

  return {
    id: CONVERTER_ID,
    displayName: CONVERTER_DISPLAY_NAME,
    priority: CONVERTER_PRIORITY,

    async detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null> {
      if (source.formatHint === "undocumented-api") {
        return {
          converterId: CONVERTER_ID,
          format: "undocumented-api",
          confidence: 0.98,
          reasons: ["Explicit format hint: undocumented-api"],
        };
      }

      if (source.uri && /^https?:\/\//i.test(source.uri)) {
        const lowered = source.uri.toLowerCase();
        const confidence = /(docs|reference|developer|api)/.test(lowered) ? 0.75 : 0.55;
        return {
          converterId: CONVERTER_ID,
          format: "undocumented-api",
          confidence,
          reasons: ["HTTP source detected; attempting docs/example-based API synthesis"],
        };
      }

      if (source.contentBase64) {
        const text = safeDecodeBase64(source.contentBase64);
        if (text && /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/|https?:\/\/)/i.test(text)) {
          return {
            converterId: CONVERTER_ID,
            format: "undocumented-api",
            confidence: 0.8,
            reasons: ["Detected HTTP method signatures in unstructured content"],
          };
        }
      }

      return null;
    },

    async convert(
      source: FridaySkillConversionSource,
      ctx: FridaySkillConverterContext,
    ): Promise<FridaySkillConverterResult> {
      const crawler = createFridayApiDocCrawler({
        maxPages: 10,
        maxDepth: 2,
      });
      const corpus = await crawler.crawl(source);
      const parsed = parseFridayApiExamples(corpus);

      if (parsed.endpoints.length === 0) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "Undocumented API converter could not detect any HTTP endpoints from docs/examples.",
          { httpStatus: 422 },
        );
      }

      const synthesized = synthesizeFridayOpenApi({
        corpus,
        parsed,
      });
      const validation = validateFridayOpenApi(synthesized.spec);
      if (!validation.ok) {
        throw new FridayDomainError(
          "PARSE_ERROR",
          `Synthesized OpenAPI validation failed: ${validation.issues.join("; ")}`,
          { httpStatus: 422 },
        );
      }

      const openApiContentBase64 = Buffer.from(
        JSON.stringify(synthesized.spec, null, 2),
        "utf-8",
      ).toString("base64");

      const delegated = await delegate.convert(
        {
          contentBase64: openApiContentBase64,
          formatHint: "openai-gpt-action",
        },
        ctx,
      );

      const drafts = delegated.drafts.map((draft) =>
        patchDraftMetadata(draft, source.uri, synthesized.warnings),
      );

      return {
        converterId: CONVERTER_ID,
        detectedFormat: "undocumented-api",
        drafts,
      };
    },
  };
}

function safeDecodeBase64(input: string): string | null {
  try {
    return Buffer.from(input, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

function patchDraftMetadata(
  draft: FridayConvertedSkillDraft,
  sourceUri: string | undefined,
  synthesisWarnings: string[],
): FridayConvertedSkillDraft {
  const warnings = [
    ...draft.warnings,
    ...synthesisWarnings,
    "Generated from unstructured API documentation. Review auth, paths, and schemas before production use.",
  ];

  return {
    ...draft,
    warnings: [...new Set(warnings)],
    conversionReport: {
      ...draft.conversionReport,
      sourceFormat: "undocumented-api",
      converterId: CONVERTER_ID,
      sourceRef: sourceUri ?? draft.conversionReport.sourceRef,
    },
  };
}

