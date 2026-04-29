/**
 * Skill converter service — full implementation.
 *
 * Orchestrates: detection → conversion → validation → installation → packaging.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { FridayDomainError } from "#errors";
import { resolveSafePath } from "#utilities";
import { loadFridaySkillPackage } from "../../manifest/friday-skill-package-loader.js";
import { validateFridaySkillPackage } from "../../validation/friday-skill-validation-pipeline.js";
import type { FridaySkillValidationIssue } from "../../validation/friday-skill-validation.types.js";
import type {
  FridayConvertedSkillDraft,
  FridaySkillConversionSource,
  FridaySkillConverterContext,
  FridaySkillConverterDetection,
  FridaySkillSourceFormat,
} from "../model/friday-skill-converter.types.js";
import type { FridaySkillConverterRegistry } from "./friday-skill-converter-registry.js";
import type {
  FridaySkillImportInstaller,
  FridaySkillInstallResult,
  FridaySkillInstallTarget,
} from "./friday-skill-import-installer.js";
import type { FridaySkillPackageArchiver } from "./friday-skill-package-archive.js";
import { summarizeFridaySkillConversionQuality } from "./friday-skill-converter-quality.js";
import type {
  FridaySkillConverterService,
  FridaySkillConvertInput,
  FridaySkillConvertOutput,
  FridaySkillImportInput,
  FridaySkillImportOutput,
  FridaySkillPackInput,
  FridaySkillPackOutput,
} from "./friday-skill-converter-service.types.js";

// ─── Dependencies ───

export interface CreateFridaySkillConverterServiceDeps {
  registry: FridaySkillConverterRegistry;
  installer: FridaySkillImportInstaller;
  archiver: FridaySkillPackageArchiver;
  context: FridaySkillConverterContext;
  hubVersion?: string;
  supportedApiVersions?: string[];
  onSkillImported?: (event: FridaySkillImportedEvent) => Promise<void> | void;
  onRegistryRefresh?: () => Promise<void>;
}

export interface FridaySkillImportedEvent {
  draft: FridayConvertedSkillDraft;
  installResult: FridaySkillInstallResult;
  source: FridaySkillConversionSource;
  target: FridaySkillInstallTarget;
  converterId: string;
  detectedFormat: FridaySkillSourceFormat;
}

// ─── Factory ───

export function createFridaySkillConverterService(
  deps: CreateFridaySkillConverterServiceDeps,
): FridaySkillConverterService {
  const {
    registry,
    installer,
    archiver,
    context,
    hubVersion = "1.0.0",
    supportedApiVersions = ["1"],
    onSkillImported,
    onRegistryRefresh,
  } = deps;

  return {
    listConverters(): Array<{ id: string; displayName: string; sourceFormats: FridaySkillSourceFormat[] }> {
      return registry.list().map((converter) => ({
        id: converter.id,
        displayName: converter.displayName,
        sourceFormats: getConverterSourceFormats(converter.id),
      }));
    },

    async detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null> {
      return registry.detect(source);
    },

    async convert(input: FridaySkillConvertInput): Promise<FridaySkillConvertOutput> {
      const { source, formatHint, options } = input;

      // Detect converter
      const sourceWithHint: FridaySkillConversionSource = {
        ...source,
        ...(formatHint && formatHint !== "auto" ? { formatHint } : {}),
      };

      const detection = await registry.detect(sourceWithHint);
      if (!detection) {
        throw new FridayDomainError("CONVERTER_NOT_FOUND", "No converter detected for the given source", { httpStatus: 404 });
      }

      // If the converter supports options (e.g., OpenAPI), create a configured instance
      let converter = registry.getConverter(detection.converterId);
      if (!converter) {
        throw new FridayDomainError("CONVERTER_NOT_FOUND", `Converter not found: ${detection.converterId}`, { httpStatus: 404 });
      }

      if (detection.converterId === "openai-gpt-action" && options) {
        const { createFridayOpenAiGptActionConverter } = await import("../converters/friday-openai-gpt-action-converter.js");
        converter = createFridayOpenAiGptActionConverter({
          splitOperations: options.splitOperations,
          skillIdPrefix: options.skillIdPrefix,
        });
      }

      // Convert
      const result = await converter.convert(source, context);

      // Validate each draft
      const validation = await validateDrafts(result.drafts, context, hubVersion, supportedApiVersions);
      const quality = summarizeFridaySkillConversionQuality(validation);

      return {
        ...result,
        validation,
        quality,
      };
    },

    async import(input: FridaySkillImportInput): Promise<FridaySkillImportOutput> {
      const {
        source,
        formatHint,
        target = "managed",
        replace = false,
        refreshRegistry: shouldRefresh = true,
        dryRun = false,
        options,
      } = input;

      // Detect converter
      const sourceWithHint: FridaySkillConversionSource = {
        ...source,
        ...(formatHint && formatHint !== "auto" ? { formatHint } : {}),
      };

      const detection = await registry.detect(sourceWithHint);
      if (!detection) {
        throw new FridayDomainError("CONVERTER_NOT_FOUND", "No converter detected for the given source", { httpStatus: 404 });
      }

      // If the converter supports options (e.g., OpenAPI), create a configured instance
      let converter = registry.getConverter(detection.converterId);
      if (!converter) {
        throw new FridayDomainError("CONVERTER_NOT_FOUND", `Converter not found: ${detection.converterId}`, { httpStatus: 404 });
      }

      if (detection.converterId === "openai-gpt-action" && options) {
        const { createFridayOpenAiGptActionConverter } = await import("../converters/friday-openai-gpt-action-converter.js");
        converter = createFridayOpenAiGptActionConverter({
          splitOperations: options.splitOperations,
          skillIdPrefix: options.skillIdPrefix,
        });
      }

      // Convert
      const result = await converter.convert(source, context);

      // Install each draft (unless dryRun)
      const imports: FridaySkillImportOutput["imports"] = [];

      if (dryRun) {
        // In dry-run mode, validate but don't install
        const validation = await validateDrafts(result.drafts, context, hubVersion, supportedApiVersions);
        for (let i = 0; i < result.drafts.length; i++) {
          const draft = result.drafts[i]!;
          const v = validation[i];
          imports.push({
            skillId: draft.manifest.id,
            skillDir: "",
            installed: false,
            issues: v?.issues ?? [],
          });
        }
      } else {
        for (const draft of result.drafts) {
          const installResult = installer.installConvertedSkill(draft, target, {
            replace,
            workspaceDir: context.workspaceDir,
            managedSkillsDir: context.managedSkillsDir,
            hubVersion,
            supportedApiVersions,
          });

          imports.push(installResult);
          if (installResult.installed && onSkillImported) {
            await onSkillImported({
              draft,
              installResult,
              source,
              target,
              converterId: result.converterId,
              detectedFormat: result.detectedFormat,
            });
          }
        }
      }

      // Refresh registry if requested and at least one install succeeded
      let registryRefreshed = false;
      if (!dryRun && shouldRefresh && imports.some((i) => i.installed) && onRegistryRefresh) {
        await onRegistryRefresh();
        registryRefreshed = true;
      }

      return {
        converterId: result.converterId,
        detectedFormat: result.detectedFormat,
        imports,
        registryRefreshed,
      };
    },

    async pack(input: FridaySkillPackInput): Promise<FridaySkillPackOutput> {
      const { skillDir, outputFile } = input;

      // Validate the skill package first
      const loadResult = loadFridaySkillPackage({
        skillDir,
        workspaceDir: context.workspaceDir,
      });

      if (!loadResult.ok) {
        throw new FridayDomainError("VALIDATION_ERROR", `Failed to load skill package for packing: ${loadResult.error.message}`, { httpStatus: 400 });
      }

      const validationResult = validateFridaySkillPackage({
        loaded: loadResult.value,
        workspaceDir: context.workspaceDir,
        hubVersion,
        supportedApiVersions,
      });

      const errors = validationResult.issues.filter((i) => i.severity === "error");
      if (errors.length > 0) {
        const errorMessages = errors.map((e) => e.message).join("; ");
        throw new FridayDomainError("VALIDATION_ERROR", `Skill package validation failed: ${errorMessages}`, { httpStatus: 422 });
      }

      // Archive
      return archiver.packSkill(skillDir, outputFile);
    },
  };
}

// ─── Helpers ───

function getConverterSourceFormats(converterId: string): FridaySkillSourceFormat[] {
  const formatMap: Record<string, FridaySkillSourceFormat[]> = {
    "native-friday-package": ["friday-package"],
    "adk-skill": ["adk-skill"],
    "clawdbot-skill-md": ["clawdbot-skill-md"],
    "n8n-node": ["n8n-node"],
    "openai-gpt-action": ["openai-gpt-action"],
    "code-repo": ["code-repo"],
    "undocumented-api": ["undocumented-api"],
    "desktop-recording": ["desktop-recording"],
  };

  return formatMap[converterId] ?? ["unknown"];
}

async function validateDrafts(
  drafts: FridayConvertedSkillDraft[],
  context: FridaySkillConverterContext,
  hubVersion: string,
  supportedApiVersions: string[],
): Promise<Array<{ skillId: string; ok: boolean; issues: FridaySkillValidationIssue[] }>> {
  const results: Array<{ skillId: string; ok: boolean; issues: FridaySkillValidationIssue[] }> = [];

  for (const draft of drafts) {
    const stagingDir = join(
      tmpdir(),
      `friday-validate-${draft.manifest.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    try {
      // Stage files for validation
      mkdirSync(stagingDir, { recursive: true });
      for (const file of draft.files) {
        const filePath = resolveSafePath(stagingDir, file.path);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.content, "utf-8");
        if (file.executable) {
          chmodSync(filePath, 0o755);
        }
      }

      // Load and validate
      const loadResult = loadFridaySkillPackage({
        skillDir: stagingDir,
        workspaceDir: context.workspaceDir,
      });

      if (!loadResult.ok) {
        results.push({
          skillId: draft.manifest.id,
          ok: false,
          issues: [
            {
              stage: "manifest",
              severity: "error",
              code: "PACKAGE_LOAD_FAILED",
              message: loadResult.error.message,
            },
          ],
        });
        continue;
      }

      const validationResult = validateFridaySkillPackage({
        loaded: loadResult.value,
        workspaceDir: context.workspaceDir,
        hubVersion,
        supportedApiVersions,
      });

      results.push({
        skillId: draft.manifest.id,
        ok: validationResult.ok,
        issues: validationResult.issues,
      });
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  return results;
}
