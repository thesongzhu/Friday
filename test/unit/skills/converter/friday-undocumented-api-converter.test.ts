import { describe, it, expect } from "vitest";

import { createFridayUndocumentedApiConverter } from "#skills/converter";
import type { FridaySkillConverterContext } from "#skills/converter";

const NOW_ISO = "2026-02-23T12:00:00.000Z";

function makeCtx(overrides: Partial<FridaySkillConverterContext> = {}): FridaySkillConverterContext {
  return {
    workspaceDir: "/workspace",
    managedSkillsDir: "/managed-skills",
    nowIso: () => NOW_ISO,
    ...overrides,
  };
}

describe("FridayUndocumentedApiConverter", () => {
  it("detects from explicit format hint", async () => {
    const converter = createFridayUndocumentedApiConverter();
    const detection = await converter.detect({
      uri: "https://docs.example.com/api",
      formatHint: "undocumented-api",
    });

    expect(detection).not.toBeNull();
    expect(detection?.converterId).toBe("undocumented-api");
    expect(detection?.format).toBe("undocumented-api");
    expect(detection?.confidence).toBeGreaterThan(0.9);
  });

  it("converts unstructured docs into delegated skill drafts", async () => {
    const converter = createFridayUndocumentedApiConverter();
    const docs = `
      # Example API Docs
      Base URL: https://api.example.com

      GET /v1/users
      POST /v1/users
      DELETE https://api.example.com/v1/users/{userId}

      Authorization: Bearer <token>
    `;
    const contentBase64 = Buffer.from(docs, "utf-8").toString("base64");

    const result = await converter.convert(
      {
        contentBase64,
        formatHint: "undocumented-api",
      },
      makeCtx(),
    );

    expect(result.converterId).toBe("undocumented-api");
    expect(result.detectedFormat).toBe("undocumented-api");
    expect(result.drafts.length).toBeGreaterThan(0);

    const draft = result.drafts[0]!;
    expect(draft.conversionReport.converterId).toBe("undocumented-api");
    expect(draft.conversionReport.sourceFormat).toBe("undocumented-api");
    expect(
      draft.warnings.some((w) =>
        w.includes("Generated from unstructured API documentation"),
      ),
    ).toBe(true);
  });

  it("throws when docs do not contain endpoint signatures", async () => {
    const converter = createFridayUndocumentedApiConverter();
    const docs = "This text has no API method signatures.";
    const contentBase64 = Buffer.from(docs, "utf-8").toString("base64");

    await expect(
      converter.convert({ contentBase64, formatHint: "undocumented-api" }, makeCtx()),
    ).rejects.toThrow("could not detect any HTTP endpoints");
  });
});

