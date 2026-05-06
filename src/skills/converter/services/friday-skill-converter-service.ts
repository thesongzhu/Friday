/**
 * Skill converter service — full implementation.
 *
 * Orchestrates detection, conversion, validation, staged candidates, and
 * packaging. Public convert is preview-only; import creates candidates without
 * install/availability and promotion must go through the external lifecycle.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { FridayDomainError } from "#errors";
import {
  createFridayMutatingActionDigest,
  type FridayMutatingActionTicket,
} from "../../../security/friday-mutating-action-gate.js";
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
import {
  createFridaySkillCandidateStore,
  redactFridaySkillSourceValue,
  type FridayExternalSkillCandidate,
} from "./friday-skill-candidate-store.js";
import { summarizeFridaySkillConversionQuality } from "./friday-skill-converter-quality.js";
import { createFridaySkillStageMutatingActionRequest } from "./friday-skill-staging-approval.js";
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
  onSkillCandidateStaged?: (event: FridaySkillCandidateEvent) => Promise<void> | void;
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

export interface FridaySkillCandidateEvent {
  candidate: FridayExternalSkillCandidate;
  draft: FridayConvertedSkillDraft;
}

// ─── Factory ───

export function createFridaySkillConverterService(
  deps: CreateFridaySkillConverterServiceDeps,
): FridaySkillConverterService {
  const {
    registry,
    archiver,
    context,
    hubVersion = "1.0.0",
    supportedApiVersions = ["1"],
  } = deps;
  const candidateStore = createFridaySkillCandidateStore({
    context,
    hubVersion,
    supportedApiVersions,
    onCandidateStaged: deps.onSkillCandidateStaged,
  });

  async function convertAndValidate(input: FridaySkillConvertInput): Promise<FridaySkillConvertOutput> {
    const { source, formatHint, options } = input;

    const sourceWithHint: FridaySkillConversionSource = {
      ...source,
      ...(formatHint && formatHint !== "auto" ? { formatHint } : {}),
    };

    const detection = await registry.detect(sourceWithHint);
    if (!detection) {
      throw new FridayDomainError("CONVERTER_NOT_FOUND", "No converter detected for the given source", { httpStatus: 404 });
    }

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

    const result = await converter.convert(source, context);
    const validation = await validateDrafts(result.drafts, context, hubVersion, supportedApiVersions);
    const quality = summarizeFridaySkillConversionQuality(validation);

    const output: FridaySkillConvertOutput = {
      ...result,
      validation,
      quality,
    };
    return redactFridaySkillSourceValue(output, sourceWithHint) as FridaySkillConvertOutput;
  }

  function assertCanonicalStageTicket(input: FridaySkillImportInput): FridayMutatingActionTicket {
    const ticket = input.canonicalApprovalTicket;
    if (!ticket) {
      throw new FridayDomainError(
        "SKILL_IMPORT_CANONICAL_TICKET_REQUIRED",
        "Skill import candidate writes require a canonical approval ticket.",
        { httpStatus: 403 },
      );
    }
    if (ticket.action !== "skills.import.stage_candidate" || ticket.resource.type !== "external_skill_candidate") {
      throw new FridayDomainError(
        "SKILL_IMPORT_CANONICAL_TICKET_INVALID",
        "Skill import canonical approval ticket does not authorize external skill candidate staging.",
        { httpStatus: 403, details: { ticketId: ticket.ticketId, action: ticket.action, resourceType: ticket.resource.type } },
      );
    }

    const expectedRequest = createFridaySkillStageMutatingActionRequest({
      source: input.source,
      formatHint: input.formatHint,
      target: input.target,
      replace: input.replace,
      refreshRegistry: input.refreshRegistry,
      options: input.options,
      actor: ticket.actor,
      surface: ticket.surface,
      idempotencyKey: ticket.idempotencyKey,
      planDigest: ticket.planDigest,
    });
    const expectedDigest = createFridayMutatingActionDigest(expectedRequest);
    if (expectedDigest !== ticket.actionDigest) {
      throw new FridayDomainError(
        "SKILL_IMPORT_CANONICAL_TICKET_DIGEST_MISMATCH",
        "Skill import canonical approval ticket does not match the staged candidate request.",
        {
          httpStatus: 403,
          details: {
            ticketId: ticket.ticketId,
            expectedDigest,
            actualDigest: ticket.actionDigest,
          },
        },
      );
    }
    return ticket;
  }

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
      return convertAndValidate(input);
    },

    getCandidate(input) {
      return candidateStore.get(input);
    },

    async import(input: FridaySkillImportInput): Promise<FridaySkillImportOutput> {
      const canonicalApprovalTicket = assertCanonicalStageTicket(input);
      const result = await convertAndValidate(input);
      const candidates = await Promise.all(result.drafts.map((draft) => {
        const draftValidation = result.validation.find((item) => item.skillId === draft.manifest.id) ?? {
          skillId: draft.manifest.id,
          ok: false,
          issues: [],
        };
        return candidateStore.stage({
          source: input.source,
          converterId: result.converterId,
          detectedFormat: result.detectedFormat,
          draft,
          validation: {
            ok: draftValidation.ok,
            issues: draftValidation.issues,
          },
          canonicalApprovalTicket,
        });
      }));

      return {
        converterId: result.converterId,
        detectedFormat: result.detectedFormat,
        candidates,
        validation: result.validation,
        quality: result.quality,
        registryRefreshed: false,
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
