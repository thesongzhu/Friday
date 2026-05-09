// Types
export type {
  FridaySkillSourceFormat,
  FridaySkillConversionSource,
  FridaySkillConverterDetection,
  FridayConvertedSkillFile,
  FridayConvertedSkillDraft,
  FridaySkillConversionReport,
  FridaySkillConverterResult,
  FridaySkillConverterContext,
  FridaySkillConverter,
} from "./model/friday-skill-converter.types.js";
export {
  FRIDAY_SKILL_SOURCE_FORMATS,
  FRIDAY_SKILL_SOURCE_FORMAT_HINTS,
} from "./model/friday-skill-converter.types.js";

// Pipeline types ported from the deprecated compat surface during C-006 convergence
export {
  FRIDAY_CONVERTER_PIPELINE_STATES,
  FRIDAY_CONVERTER_PIPELINE_TRANSITIONS,
  FRIDAY_CONVERTER_PIPELINE_TERMINAL_STATES,
  FRIDAY_CONVERTER_QUALITY_GATES,
  FRIDAY_CONVERTER_DIAGNOSTIC_SEVERITIES,
  FRIDAY_CANONICAL_CONVERTER_STACK,
} from "./model/friday-skill-converter-pipeline.types.js";

export type {
  FridayConverterPipelineState,
  FridayConverterPipelineStage,
  FridayConverterQualityGate,
  FridayConverterQualityCheck,
  FridayConverterQualityResult,
  FridayConverterDiagnosticSeverity,
  FridayConverterDiagnostic,
  FridayConverterPipelineRecord,
  FridayConverterStack,
} from "./model/friday-skill-converter-pipeline.types.js";

// Registry
export {
  createFridaySkillConverterRegistry,
} from "./services/friday-skill-converter-registry.js";

export type {
  FridaySkillConverterRegistry,
} from "./services/friday-skill-converter-registry.js";

export {
  extractMarkdownCommands,
} from "./utils/friday-markdown-command-extractor.js";

export type {
  ExtractedCommand,
} from "./utils/friday-markdown-command-extractor.js";

// Converters
export {
  createClawdbotSkillMdConverter,
  createFridayCodeRepoConverter,
  FRIDAY_DEFAULT_CONVERTER_FACTORIES,
  createNativeSkillPackageConverter,
  createFridayN8nNodeConverter,
  createFridayOpenAiGptActionConverter,
  createFridayUndocumentedApiConverter,
  createFridayRecordingConverter,
} from "./converters/index.js";

export type {
  OpenAiGptActionConverterOptions,
} from "./converters/index.js";

export type {
  FridayCodeRepoCapabilityKind,
  FridayCodeRepoFile,
  FridayCodeRepoMaterializedSource,
  FridayCodeRepoLanguageProfile,
  FridayCodeRepoCapability,
  FridayCodeRepoAnalysisResult,
  FridayCodeRepoDraftPlan,
} from "./code-repo/friday-code-repo.types.js";

export type {
  FridayApiDocsPage,
  FridayApiDocsCorpus,
  FridayParsedApiEndpoint,
  FridayApiExampleParseResult,
  FridaySynthesizedOpenApi,
  FridayOpenApiValidationResult,
} from "./undocumented-api/friday-undocumented-api.types.js";

// Undocumented API crawler
export {
  createFridayApiDocCrawler,
  extractSameOriginLinks,
  extractOrigin,
} from "./undocumented-api/friday-api-doc-crawler.js";

export type {
  CreateFridayApiDocCrawlerDeps,
  FridayApiDocCrawler,
} from "./undocumented-api/friday-api-doc-crawler.js";

// Services
export {
  createFridaySkillImportInstaller,
} from "./services/friday-skill-import-installer.js";

export type {
  FridaySkillImportInstaller,
  FridaySkillInstallTarget,
  FridaySkillInstallOptions,
  FridaySkillInstallResult,
} from "./services/friday-skill-import-installer.js";

export {
  createFridaySkillPackageArchiver,
} from "./services/friday-skill-package-archive.js";

export type {
  FridaySkillPackageArchiver,
  FridaySkillPackResult,
} from "./services/friday-skill-package-archive.js";

export type {
  FridaySkillConverterService,
  FridaySkillConvertInput,
  FridaySkillConvertOutput,
  FridaySkillConversionQualitySummary,
  FridaySkillImportInput,
  FridaySkillImportOutput,
  FridaySkillPackInput,
  FridaySkillPackOutput,
} from "./services/friday-skill-converter-service.types.js";

export {
  createFridaySkillConverterService,
} from "./services/friday-skill-converter-service.js";

export type {
  FridayExternalSkillCandidate,
  FridaySkillCandidateSourceProvenance,
  FridaySkillCandidateValidation,
} from "./services/friday-skill-candidate-store.js";

export {
  createFridaySkillCandidateSourceProvenance,
  formatFridaySkillCandidateSourceProvenance,
  redactFridaySkillCandidateSourceUri,
  redactFridaySkillSourceText,
  redactFridaySkillSourceValue,
} from "./services/friday-skill-candidate-store.js";

export {
  summarizeFridaySkillConversionQuality,
} from "./services/friday-skill-converter-quality.js";

export {
  createFridaySkillStageMutatingActionRequest,
} from "./services/friday-skill-staging-approval.js";

export type {
  FridaySkillStageApprovalInput,
} from "./services/friday-skill-staging-approval.js";

export type {
  CreateFridaySkillConverterServiceDeps,
  FridaySkillImportedEvent,
  FridaySkillCandidateEvent,
} from "./services/friday-skill-converter-service.js";

// Discovery (E5)
export {
  DEFAULT_DISCOVERY_POLICY,
  createDarwinProgramScanner,
  createWin32ProgramScanner,
  createLinuxProgramScanner,
  generateRecommendations,
  createFridayProgramDiscoveryService,
} from "./discovery/index.js";

export type {
  FridayDiscoveryPlatform,
  FridayProgramCategory,
  FridayDiscoveredProgram,
  FridayProgramCatalog,
  FridayIntegrationPath,
  FridayIntegrationRecommendation,
  FridayRecommendationResult,
  FridayDiscoveryFilterOptions,
  FridayDiscoveryPolicy,
  FridayProgramScanner,
  FridayProgramDiscoveryService,
  CreateFridayProgramDiscoveryServiceDeps,
} from "./discovery/index.js";
