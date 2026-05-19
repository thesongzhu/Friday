import * as fs from "node:fs";
import * as path from "node:path";

import type {
  FridayStudioArtifactCandidateValidation,
  FridayStudioImportedPack,
  FridayStudioLocalizedText,
  FridayStudioRun,
} from "../api/model/friday-api-studio.types.js";
import type { FridayCapabilityCandidate } from "../autonomy/model/friday-controlled-autonomy.types.js";

export interface ValidateStudioArtifactInput {
  run?: FridayStudioRun;
  importedPack?: FridayStudioImportedPack;
}

const INTEGRATION_PACK_SCHEMA_PREFIX = "friday.studio.integration_pack";
const GUIDED_BROWSER_SCHEMA_PREFIX = "friday.studio.guided_browser";
const CREDENTIAL_PATTERNS = /(?:api[_-]?key|secret|token|password)\s*[:=]\s*(?:["'][^"']{8,}|[^\s'"]{12,})|bearer\s+[a-z0-9_\-.]{12,}|authorization\s*:\s*bearer\s+[a-z0-9_\-.]{12,}/i;

export function validateStudioArtifactAsCandidate(
  input: ValidateStudioArtifactInput,
): FridayStudioArtifactCandidateValidation {
  const checks: FridayStudioArtifactCandidateValidation["checks"] = [];
  const { run, importedPack } = input;

  if (!run && !importedPack) {
    return invalidResult("No studio run or imported pack provided", checks);
  }

  if (run) {
    return validateRunAsCandidate(run, checks);
  }

  return validateImportedPackAsCandidate(importedPack!, checks);
}

function validateRunAsCandidate(
  run: FridayStudioRun,
  checks: FridayStudioArtifactCandidateValidation["checks"],
): FridayStudioArtifactCandidateValidation {
  checks.push(statusCheck(run.status === "completed"));
  if (run.status !== "completed") {
    return invalidResult("Studio run did not complete successfully", checks);
  }

  const isIntegration = run.productId === "integration_builder";
  const isGuide = run.productId === "guided_browser_automation";
  checks.push(productCheck(isIntegration || isGuide, run.productId));

  if (!isIntegration && !isGuide) {
    return invalidResult(
      `Product ${run.productId} does not produce registerable capability artifacts`,
      checks,
    );
  }

  const packArtifact = run.artifacts.find(
    (a) => a.relativePath === "pack.json" || a.id === "integration_pack" || a.id === "guide_pack",
  );
  checks.push(packJsonCheck(Boolean(packArtifact)));
  if (!packArtifact) {
    return invalidResult("No pack.json artifact found in the run", checks);
  }

  const permissions = extractPermissionsFromRun(run);
  const operationCount = extractOperationCountFromRun(run);
  const risks = deriveRisks(permissions);
  checks.push(permissionCheck(permissions));
  checks.push(credentialSafetyCheck(run));

  const inferredCapabilities: string[] = isIntegration
    ? ["custom", "skills"]
    : ["custom"];

  return {
    valid: true,
    candidateLabel: run.title || `Studio ${run.productId}`,
    candidateDescription: localText(run.summary) || `Generated from Studio ${run.productId} run`,
    inferredCapabilities,
    permissions,
    operationCount,
    risks,
    trustTier: "generated",
    sourceType: "studio_artifact",
    checks,
  };
}

function validateImportedPackAsCandidate(
  pack: FridayStudioImportedPack,
  checks: FridayStudioArtifactCandidateValidation["checks"],
): FridayStudioArtifactCandidateValidation {
  checks.push(importCheck(pack.fileCount > 0));
  if (pack.fileCount === 0) {
    return invalidResult("Imported pack contains no files", checks);
  }

  checks.push(packJsonCheck(Boolean(pack.packJsonPath)));
  if (!pack.packJsonPath) {
    return invalidResult("Imported pack has no pack.json", checks);
  }

  const hasKnownProduct = pack.productIds.length > 0;
  const isIntegration = pack.productIds.includes("integration_builder");
  const isGuide = pack.productIds.includes("guided_browser_automation");
  checks.push(productCheck(hasKnownProduct, pack.productIds.join(", ") || "unknown"));

  if (!isIntegration && !isGuide) {
    return invalidResult(
      "Imported pack does not match a registerable product type",
      checks,
    );
  }

  const inferredCapabilities: string[] = isIntegration
    ? ["custom", "skills"]
    : ["custom"];

  return {
    valid: true,
    candidateLabel: pack.name,
    candidateDescription: pack.description,
    inferredCapabilities,
    permissions: [],
    operationCount: 0,
    risks: [],
    trustTier: "generated",
    sourceType: "studio_artifact",
    checks,
  };
}

export function buildStudioArtifactCapabilityCandidate(
  validation: FridayStudioArtifactCandidateValidation,
  sourceId: string,
): FridayCapabilityCandidate[] {
  if (!validation.valid) {
    return [];
  }
  return validation.inferredCapabilities.map((capability) => ({
    id: `studio_artifact:${sourceId}:${capability}`,
    capability: capability as FridayCapabilityCandidate["capability"],
    sourceType: "studio_artifact" as const,
    trustTier: "generated" as const,
    label: validation.candidateLabel,
    description: validation.candidateDescription,
    risks: validation.risks as FridayCapabilityCandidate["risks"],
    requiresApproval: true,
    requiresHuman: validation.risks.some((r) => r === "api_key"),
    rank: 35,
  }));
}

function invalidResult(
  reason: string,
  checks: FridayStudioArtifactCandidateValidation["checks"],
): FridayStudioArtifactCandidateValidation {
  checks.push({
    id: "validation_result",
    label: localized("验证结果", "Validation result"),
    status: "failed",
    detail: localized(reason, reason),
  });
  return {
    valid: false,
    candidateLabel: "",
    candidateDescription: reason,
    inferredCapabilities: [],
    permissions: [],
    operationCount: 0,
    risks: [],
    trustTier: "generated",
    sourceType: "studio_artifact",
    checks,
  };
}

function statusCheck(passed: boolean): FridayStudioArtifactCandidateValidation["checks"][number] {
  return {
    id: "run_status",
    label: localized("运行状态", "Run status"),
    status: passed ? "passed" : "failed",
    detail: localized(
      passed ? "Studio 运行已完成。" : "Studio 运行未成功完成。",
      passed ? "Studio run completed successfully." : "Studio run did not complete.",
    ),
  };
}

function productCheck(passed: boolean, productId: string): FridayStudioArtifactCandidateValidation["checks"][number] {
  return {
    id: "product_type",
    label: localized("产品类型", "Product type"),
    status: passed ? "passed" : "failed",
    detail: localized(
      passed ? `产品 ${productId} 可生成可注册的能力候选。` : `产品 ${productId} 不产生可注册的能力产物。`,
      passed ? `Product ${productId} produces registerable capability artifacts.` : `Product ${productId} does not produce registerable capability artifacts.`,
    ),
  };
}

function packJsonCheck(found: boolean): FridayStudioArtifactCandidateValidation["checks"][number] {
  return {
    id: "pack_json",
    label: localized("pack.json", "pack.json"),
    status: found ? "passed" : "failed",
    detail: localized(
      found ? "找到 pack.json 候选产物。" : "未找到 pack.json 产物。",
      found ? "Found pack.json candidate artifact." : "No pack.json artifact found.",
    ),
  };
}

function importCheck(hasFiles: boolean): FridayStudioArtifactCandidateValidation["checks"][number] {
  return {
    id: "import_files",
    label: localized("导入文件", "Import files"),
    status: hasFiles ? "passed" : "failed",
    detail: localized(
      hasFiles ? "导入包包含文件。" : "导入包为空。",
      hasFiles ? "Imported pack contains files." : "Imported pack is empty.",
    ),
  };
}

function permissionCheck(permissions: string[]): FridayStudioArtifactCandidateValidation["checks"][number] {
  const hasCredentialPermission = permissions.some((p) => p.includes("secret") || p.includes("api_key"));
  return {
    id: "permissions",
    label: localized("权限声明", "Permission declaration"),
    status: hasCredentialPermission ? "warning" : "passed",
    detail: localized(
      hasCredentialPermission
        ? "需要用户配置真实密钥和认证方式。"
        : "无需外部密钥即可注册。",
      hasCredentialPermission
        ? "Real credentials and authentication must be configured by the user."
        : "No external credential is required for registration.",
    ),
  };
}

function credentialSafetyCheck(run: FridayStudioRun): FridayStudioArtifactCandidateValidation["checks"][number] {
  const inputValues = Object.values(run.inputs).map(String).join(" ");
  const hasSuspiciousContent = CREDENTIAL_PATTERNS.test(inputValues);
  return {
    id: "credential_safety",
    label: localized("凭据安全", "Credential safety"),
    status: hasSuspiciousContent ? "warning" : "passed",
    detail: localized(
      hasSuspiciousContent
        ? "输入中可能包含凭据。注册前请移除敏感信息。"
        : "输入中未检测到凭据模式。",
      hasSuspiciousContent
        ? "Input may contain credentials. Remove sensitive material before registration."
        : "No credential patterns detected in inputs.",
    ),
  };
}

function extractPermissionsFromRun(run: FridayStudioRun): string[] {
  const packArtifact = run.artifacts.find((a) => a.id === "integration_pack" || a.id === "guide_pack");
  if (!packArtifact) return [];
  if (run.productId === "integration_builder") {
    return readPackPermissions(run, packArtifact.relativePath) ?? ["network.request"];
  }
  return [];
}

function readPackPermissions(run: FridayStudioRun, relativePath: string): string[] | null {
  try {
    const root = path.resolve(run.artifactRoot);
    const fullPath = path.resolve(root, relativePath);
    if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as { permissions?: unknown };
    if (!Array.isArray(parsed.permissions)) {
      return null;
    }
    return parsed.permissions.filter((permission): permission is string => typeof permission === "string");
  } catch {
    return null;
  }
}

function extractOperationCountFromRun(run: FridayStudioRun): number {
  const summary = localText(run.summary);
  const match = summary.match(/(\d+)\s*(?:candidate operations|候选操作)/);
  return match ? parseInt(match[1]!, 10) : 0;
}

function deriveRisks(permissions: string[]): string[] {
  const risks: string[] = [];
  if (permissions.includes("network.request")) {
    risks.push("network_call");
  }
  if (permissions.some((p) => p.includes("secret") || p.includes("api_key"))) {
    risks.push("api_key");
  }
  return risks;
}

function localText(text: FridayStudioLocalizedText | string): string {
  if (typeof text === "string") return text;
  return text.en || text.zh;
}

function localized(zh: string, en: string): FridayStudioLocalizedText {
  return { zh, en };
}
