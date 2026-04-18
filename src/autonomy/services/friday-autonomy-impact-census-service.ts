import semver from "semver";

import type { FridayAutonomySubjectInventoryService } from "./friday-autonomy-subject-inventory-service.js";
import type {
  FridayAutonomyImpactCensusContext,
  FridayUpgradeImpactFinding,
  FridayUpgradeImpactSnapshot,
} from "../model/friday-autonomy-impact.types.js";
import type { FridayAutonomySubjectRecord } from "../model/friday-autonomy-subject.types.js";
import type { FridayAutonomyCompatibilityStatus } from "../model/friday-autonomy-upgrade.types.js";

export interface FridayAutonomyImpactCensusService {
  list(): FridayUpgradeImpactSnapshot[];
}

export interface CreateFridayAutonomyImpactCensusServiceDeps extends FridayAutonomyImpactCensusContext {
  inventory: Pick<FridayAutonomySubjectInventoryService, "list">;
}

export function createFridayAutonomyImpactCensusService(
  deps: CreateFridayAutonomyImpactCensusServiceDeps,
): FridayAutonomyImpactCensusService {
  const context: FridayAutonomyImpactCensusContext = {
    hubVersion: deps.hubVersion,
    supportedApiVersions: deps.supportedApiVersions,
  };

  return {
    list() {
      return deps.inventory.list().map((subject) => {
        const findings = evaluateSubject(subject, context);
        const derivedCompatibilityStatus = deriveCompatibilityStatus(findings);
        return {
          subject,
          recordedCompatibilityStatus: subject.compatibilityStatus,
          derivedCompatibilityStatus,
          requiresAdaptation: derivedCompatibilityStatus !== "compatible",
          statusDrift: derivedCompatibilityStatus !== subject.compatibilityStatus,
          findings,
        };
      });
    },
  };
}

function evaluateSubject(
  subject: FridayAutonomySubjectRecord,
  context: FridayAutonomyImpactCensusContext,
): FridayUpgradeImpactFinding[] {
  switch (subject.kind) {
    case "skill":
      return [
        ...evaluateRuntimeCompatibility(subject, context),
        createFinding("skill_installed_version", "warning", Boolean(subject.activeVersion), {
          message: subject.activeVersion
            ? `Skill has an active version (${subject.activeVersion}).`
            : "Skill does not have an installed or active version.",
          actualValue: subject.activeVersion ?? null,
        }),
      ];
    case "plugin":
      return [
        ...evaluateRuntimeCompatibility(subject, context),
        createFinding("plugin_enabled", "warning", readBoolean(subject, "enabled") !== false, {
          message: readBoolean(subject, "enabled") !== false
            ? "Plugin is enabled for runtime use."
            : "Plugin exists but is not enabled.",
          actualValue: readBoolean(subject, "enabled"),
          expectedValue: true,
        }),
      ];
    case "workflow":
      return evaluateWorkflow(subject);
    case "provider_profile":
      return evaluateProviderProfile(subject);
    case "mcp_server":
      return evaluateMcpServer(subject);
    case "channel_adapter":
      return evaluateChannelAdapter(subject);
    default:
      return [];
  }
}

function evaluateRuntimeCompatibility(
  subject: FridayAutonomySubjectRecord,
  context: FridayAutonomyImpactCensusContext,
): FridayUpgradeImpactFinding[] {
  const findings: FridayUpgradeImpactFinding[] = [];
  const apiVersion = readString(subject, "apiVersion") ?? readString(subject, "runtimeApiVersion");
  const minHubVersion = readString(subject, "minHubVersion");

  if (apiVersion) {
    findings.push(
      createFinding("api_version_supported", "blocking", context.supportedApiVersions.includes(apiVersion), {
        message: context.supportedApiVersions.includes(apiVersion)
          ? `API version ${apiVersion} is supported.`
          : `API version ${apiVersion} is not supported by the current hub.`,
        actualValue: apiVersion,
        expectedValue: context.supportedApiVersions.join(","),
      }),
    );
  }

  if (minHubVersion) {
    const minHub = semver.valid(semver.coerce(minHubVersion));
    const currentHub = semver.valid(semver.coerce(context.hubVersion));
    const passed = Boolean(minHub && currentHub && semver.lte(minHub, currentHub));
    findings.push(
      createFinding("min_hub_version", "blocking", passed, {
        message: passed
          ? `Minimum hub version ${minHubVersion} is satisfied.`
          : `Subject requires hub version >=${minHubVersion}, current hub is ${context.hubVersion}.`,
        actualValue: context.hubVersion,
        expectedValue: minHubVersion,
      }),
    );
  }

  return findings;
}

function evaluateWorkflow(subject: FridayAutonomySubjectRecord): FridayUpgradeImpactFinding[] {
  const findings: FridayUpgradeImpactFinding[] = [];
  const latest = readNumber(subject, "latestVersionNumber");
  const published = readNumber(subject, "publishedVersionNumber");
  const archived = subject.status === "archived";

  findings.push(
    createFinding("workflow_archived", "blocking", !archived, {
      message: archived
        ? "Workflow is archived and cannot be promoted as an active upgrade target."
        : "Workflow remains active for upgrade evaluation.",
      actualValue: subject.status,
      expectedValue: "active|published|draft",
    }),
  );

  findings.push(
    createFinding("workflow_published_version", "warning", typeof published === "number", {
      message: typeof published === "number"
        ? `Workflow has a published version (${published}).`
        : "Workflow has no published version yet.",
      actualValue: published ?? null,
    }),
  );

  if (typeof latest === "number" && typeof published === "number") {
    findings.push(
      createFinding("workflow_version_gap", "warning", latest <= published, {
        message: latest <= published
          ? "Workflow published version matches the latest version."
          : `Workflow latest version (${latest}) is ahead of published version (${published}).`,
        actualValue: latest,
        expectedValue: published,
      }),
    );
  }

  return findings;
}

function evaluateProviderProfile(subject: FridayAutonomySubjectRecord): FridayUpgradeImpactFinding[] {
  const findings: FridayUpgradeImpactFinding[] = [];
  const authMode = readString(subject, "authMode");
  const keySourceKind = readString(subject, "keySourceKind");
  const validationStatus = readString(subject, "validationStatus");
  const supportedModels = readStringArray(subject, "supportedModels");

  const requiresCredential = authMode != null && authMode !== "none";
  findings.push(
    createFinding("provider_credentials", "blocking", !requiresCredential || keySourceKind !== "none", {
      message: !requiresCredential || keySourceKind !== "none"
        ? "Provider has a credential source configured."
        : "Provider requires credentials but no key source is configured.",
      actualValue: keySourceKind ?? null,
      expectedValue: requiresCredential ? "env-ref|secret-ref|file-ref|command-ref" : "none",
    }),
  );

  findings.push(
    createFinding("provider_supported_models", "blocking", supportedModels.length > 0, {
      message: supportedModels.length > 0
        ? `Provider exposes ${supportedModels.length} supported model(s).`
        : "Provider does not advertise any supported models.",
      actualValue: supportedModels.length,
      expectedValue: 1,
    }),
  );

  findings.push(
    createFinding("provider_validation_status", "warning", validationStatus === "ok", {
      message: validationStatus === "ok"
        ? "Provider validation is healthy."
        : `Provider validation status is ${validationStatus ?? "never"}.`,
      actualValue: validationStatus ?? "never",
      expectedValue: "ok",
    }),
  );

  return findings;
}

function evaluateMcpServer(subject: FridayAutonomySubjectRecord): FridayUpgradeImpactFinding[] {
  const toolCount = readNumber(subject, "toolCount") ?? 0;
  const resourceCount = readNumber(subject, "resourceCount") ?? 0;
  const loaded = subject.status === "loaded" || subject.status === "connected" || subject.status === "ready";

  return [
    createFinding("mcp_runtime_state", "blocking", loaded, {
      message: loaded
        ? `MCP server runtime state is ${subject.status}.`
        : `MCP server runtime state is ${subject.status}, not ready for upgrade replay.`,
      actualValue: subject.status,
      expectedValue: "loaded|connected|ready",
    }),
    createFinding("mcp_inventory", "warning", toolCount + resourceCount > 0, {
      message: toolCount + resourceCount > 0
        ? `MCP server exposes ${toolCount} tools and ${resourceCount} resources.`
        : "MCP server exposes no tools or resources for replay verification.",
      actualValue: toolCount + resourceCount,
      expectedValue: 1,
    }),
  ];
}

function evaluateChannelAdapter(subject: FridayAutonomySubjectRecord): FridayUpgradeImpactFinding[] {
  const credentialStatus = readString(subject, "credentialStatus");
  const running = readBoolean(subject, "running");
  const connected = subject.status === "connected" || subject.status === "ready";

  return [
    createFinding("channel_credentials", "blocking", credentialStatus === "configured", {
      message: credentialStatus === "configured"
        ? "Channel credentials are configured."
        : `Channel credentials are ${credentialStatus ?? "missing"}.`,
      actualValue: credentialStatus ?? null,
      expectedValue: "configured",
    }),
    createFinding("channel_runtime_state", "warning", Boolean(running) && connected, {
      message: Boolean(running) && connected
        ? "Channel adapter is running and connected."
        : `Channel adapter state is running=${String(running)} status=${subject.status}.`,
      actualValue: `${String(running)}:${subject.status}`,
      expectedValue: "true:connected",
    }),
  ];
}

function deriveCompatibilityStatus(
  findings: FridayUpgradeImpactFinding[],
): FridayAutonomyCompatibilityStatus {
  if (findings.some((finding) => finding.severity === "blocking" && !finding.passed)) {
    return "blocked";
  }
  if (findings.some((finding) => !finding.passed)) {
    return "adaptation_required";
  }
  return "compatible";
}

function createFinding(
  id: string,
  severity: FridayUpgradeImpactFinding["severity"],
  passed: boolean,
  extras: Omit<FridayUpgradeImpactFinding, "id" | "severity" | "passed">,
): FridayUpgradeImpactFinding {
  return {
    id,
    severity,
    passed,
    ...extras,
  };
}

function readString(subject: FridayAutonomySubjectRecord, key: string): string | undefined {
  const value = subject.details?.[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(subject: FridayAutonomySubjectRecord, key: string): boolean | undefined {
  const value = subject.details?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(subject: FridayAutonomySubjectRecord, key: string): number | undefined {
  const value = subject.details?.[key];
  return typeof value === "number" ? value : undefined;
}

function readStringArray(subject: FridayAutonomySubjectRecord, key: string): string[] {
  const value = subject.details?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
