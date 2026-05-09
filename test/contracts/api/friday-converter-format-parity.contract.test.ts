import { describe, expect, it, vi } from "vitest";

import { createFridaySkillConverterRoutes } from "#api";
import type { FridayHttpContext } from "#api";
import { createFridayAgentSkillImportTool } from "#agent";
import {
  createFridaySkillConverterRegistry,
  createFridaySkillConverterService,
  createFridaySkillImportInstaller,
  createFridaySkillPackageArchiver,
  FRIDAY_DEFAULT_CONVERTER_FACTORIES,
  FRIDAY_SKILL_SOURCE_FORMATS,
  FRIDAY_SKILL_SOURCE_FORMAT_HINTS,
} from "#skills/converter";
import type { FridaySkillConverterService } from "#skills/converter";

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-format-parity",
    receivedAt: "2026-03-05T00:00:00.000Z",
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: null,
    ...overrides,
  };
}

function makeMockConverterService(): FridaySkillConverterService {
  return {
    listConverters: vi.fn(() => []),
    detect: vi.fn(async () => null),
    convert: vi.fn(async () => ({
      converterId: "test",
      detectedFormat: "unknown",
      drafts: [],
      validation: [],
    })),
    getCandidate: vi.fn(() => null),
    import: vi.fn(async () => ({
      converterId: "test",
      detectedFormat: "unknown",
      candidates: [],
      validation: [],
      registryRefreshed: false,
    })),
    pack: vi.fn(async () => ({
      packageFile: "/tmp/test.friday.tgz",
      checksumSha256: "checksum",
    })),
  };
}

describe("Converter format parity contract", () => {
  it("keeps source format hints in sync (formats + auto)", () => {
    const formatSet = new Set(FRIDAY_SKILL_SOURCE_FORMATS);
    const hintSet = new Set(FRIDAY_SKILL_SOURCE_FORMAT_HINTS);

    expect(hintSet.has("auto")).toBe(true);
    for (const format of formatSet) {
      expect(hintSet.has(format)).toBe(true);
    }
  });

  it("route validator accepts all declared format hints", async () => {
    const converterService = makeMockConverterService();
    const routes = createFridaySkillConverterRoutes({ converterService });
    const route = routes.find((entry) => entry.operationId === "skills.convert");
    expect(route).toBeDefined();

    for (const formatHint of FRIDAY_SKILL_SOURCE_FORMAT_HINTS) {
      await expect(
        route!.handler(
          makeCtx({
            body: {
              source: { uri: "/tmp/source" },
              formatHint,
            },
          }),
        ),
      ).resolves.toBeDefined();
    }
  });

  it("default converter factories cover all concrete formats except unknown", () => {
    const registry = createFridaySkillConverterRegistry();
    for (const factory of FRIDAY_DEFAULT_CONVERTER_FACTORIES) {
      registry.register(factory());
    }

    const service = createFridaySkillConverterService({
      registry,
      installer: createFridaySkillImportInstaller(),
      archiver: createFridaySkillPackageArchiver(),
      context: {
        workspaceDir: process.cwd(),
        managedSkillsDir: process.cwd(),
        nowIso: () => "2026-03-05T00:00:00.000Z",
      },
    });

    const supported = new Set(
      service
        .listConverters()
        .flatMap((converter) => converter.sourceFormats),
    );

    for (const format of FRIDAY_SKILL_SOURCE_FORMATS) {
      if (format === "unknown") continue;
      expect(supported.has(format)).toBe(true);
    }
  });

  it("skill_import help text stays aligned with concrete formats", () => {
    const tool = createFridayAgentSkillImportTool({
      converterService: makeMockConverterService(),
    });

    for (const format of FRIDAY_SKILL_SOURCE_FORMATS) {
      if (format === "unknown") continue;
      expect(tool.description).toContain(format);
    }
  });
});
