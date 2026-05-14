import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { loadFridaySkillPackage } from "../manifest/friday-skill-package-loader.js";
import type { SkillInvocationMode, SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { PermissionGrant } from "../model/friday-skill-permission-policy.types.js";
import type { FridaySkillEntity } from "../model/friday-skill-catalog.types.js";
import type { FridaySkillRepository } from "../persistence/friday-skill-repository.js";
import type { FridayWorkflowRepository } from "../../workflows/persistence/friday-workflow-repository.js";
import { parseGraphJson } from "../../workflows/model/friday-workflow-graph.types.js";
import type { FridayExternalSkillCandidate } from "../converter/services/friday-skill-candidate-store.js";
import type { FridayMutatingActionTicket } from "../../security/friday-mutating-action-gate.js";

// ─── Public types ───

export interface FridaySkillManifestComparisonReport {
  inputs: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  outputs: {
    added: string[];
    removed: string[];
  };
  permissions: {
    added: string[];
    removed: string[];
  };
  triggers: {
    intentsAdded: string[];
    intentsRemoved: string[];
    phrasesAdded: string[];
    phrasesRemoved: string[];
    channelsAdded: string[];
    channelsRemoved: string[];
  };
  runtime: {
    kindChanged: boolean;
    entrypointChanged: boolean;
    oldKind: string;
    newKind: string;
  };
  breakingChanges: FridaySkillBreakingChange[];
}

export interface FridaySkillBreakingChange {
  kind: "removed_required_input" | "removed_output" | "runtime_kind_change" | "workflow_mode_removed";
  detail: string;
}

export interface FridaySkillAffectedWorkflowNodeDetail {
  nodeId: string;
  effectiveSkillRef: string;
  inputMappingKeys: string[];
}

export interface FridaySkillWorkflowRegressionEntry {
  workflowId: string;
  workflowName: string;
  nodes: FridaySkillAffectedWorkflowNodeDetail[];
  verdict: "pass" | "fail";
  failures: string[];
}

export interface FridaySkillAffectedWorkflow {
  workflowId: string;
  workflowName: string;
  nodes: FridaySkillAffectedWorkflowNodeDetail[];
}

export interface FridaySkillWorkflowRegressionProof {
  overallVerdict: "pass" | "fail" | "no_affected_workflows";
  entries: FridaySkillWorkflowRegressionEntry[];
}

export interface FridaySkillUpgradeAnalysis {
  skillId: string;
  candidateId: string;
  isDuplicate: boolean;
  existingVersion: string | null;
  candidateVersion: string;
  comparisonReport: FridaySkillManifestComparisonReport | null;
  affectedWorkflows: FridaySkillAffectedWorkflow[];
  regressionProof: FridaySkillWorkflowRegressionProof;
  recommendation: "replace" | "keep" | "review_required";
  rollbackPointer: {
    available: boolean;
    previousVersion: string | null;
    previousManifestDigest: string | null;
  };
  analysisDigest: string;
  analyzedAt: string;
}

export interface FridaySkillUpgradeDecisionRecord {
  decision: "replace" | "keep";
  skillId: string;
  candidateId: string;
  analysisDigest: string;
  decidedAt: string;
  approvalProof: {
    ticketId: string;
    actionDigest: string;
    action: string;
    resource: { type: string; id: string };
    risk: string;
    approvedByPrincipalId: string;
    issuedAt: string;
  };
}

export interface FridaySkillUpgradeAnalysisService {
  analyze(input: { skillId: string; candidateId: string }): FridaySkillUpgradeAnalysis;
  applyDecision(input: {
    skillId: string;
    candidateId: string;
    decision: "replace" | "keep";
    analysisDigest: string;
    ticket: FridayMutatingActionTicket;
  }): FridaySkillUpgradeDecisionRecord;
}

// ─── Dependencies ───

export interface CreateFridaySkillUpgradeAnalysisServiceDeps {
  db: FridaySqliteLayer;
  nowIso: () => string;
  skillRepo: FridaySkillRepository;
  workflowRepo: FridayWorkflowRepository;
  workspaceDir: string;
  resolveCandidate?: (input: { skillId: string; candidateId: string }) =>
    FridayExternalSkillCandidate | null;
}

// ─── Factory ───

export function createFridaySkillUpgradeAnalysisService(
  deps: CreateFridaySkillUpgradeAnalysisServiceDeps,
): FridaySkillUpgradeAnalysisService {
  function loadCandidateManifest(
    candidate: FridayExternalSkillCandidate,
  ): SkillManifestV2 {
    const loaded = loadFridaySkillPackage({
      skillDir: candidate.filesDir,
      workspaceDir: deps.workspaceDir,
    });
    if (!loaded.ok) {
      throw new FridayDomainError(
        "UPGRADE_CANDIDATE_MANIFEST_LOAD_FAILED",
        `Failed to load manifest from staged candidate ${candidate.candidateId}: ${loaded.error.message}`,
        { httpStatus: 400 },
      );
    }
    return loaded.value.manifest;
  }

  function resolveAndLoadCandidate(
    skillId: string,
    candidateId: string,
  ): { candidate: FridayExternalSkillCandidate; manifest: SkillManifestV2 } {
    if (!deps.resolveCandidate) {
      throw new FridayDomainError(
        "UPGRADE_CANDIDATE_RESOLUTION_UNAVAILABLE",
        "Candidate resolution is not available on this runtime",
        { httpStatus: 503 },
      );
    }
    const candidate = deps.resolveCandidate({ skillId, candidateId });
    if (!candidate) {
      throw new FridayDomainError(
        "UPGRADE_CANDIDATE_NOT_FOUND",
        `No staged candidate found for skill ${skillId} with candidateId ${candidateId}`,
        { httpStatus: 404 },
      );
    }
    const manifest = loadCandidateManifest(candidate);
    return { candidate, manifest };
  }

  function normalizeForStableStringify(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map((item) => normalizeForStableStringify(item));
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record).sort().filter((key) => record[key] !== undefined)
          .map((key) => [key, normalizeForStableStringify(record[key])]),
      );
    }
    return null;
  }

  function stableStringify(value: unknown): string {
    return JSON.stringify(normalizeForStableStringify(value));
  }

  function compareManifests(
    oldManifest: SkillManifestV2,
    newManifest: SkillManifestV2,
  ): FridaySkillManifestComparisonReport {
    const oldInputKeys = new Set(oldManifest.inputs.map((i) => i.key));
    const newInputKeys = new Set(newManifest.inputs.map((i) => i.key));
    const oldOutputKeys = new Set(oldManifest.outputs.map((o) => o.key));
    const newOutputKeys = new Set(newManifest.outputs.map((o) => o.key));
    const oldGrantIds = new Set((oldManifest.permissions?.grants ?? []).map((g: PermissionGrant) => g.id));
    const newGrantIds = new Set((newManifest.permissions?.grants ?? []).map((g: PermissionGrant) => g.id));

    const inputsAdded = [...newInputKeys].filter((k) => !oldInputKeys.has(k));
    const inputsRemoved = [...oldInputKeys].filter((k) => !newInputKeys.has(k));
    const inputsChanged: string[] = [];
    for (const key of oldInputKeys) {
      if (newInputKeys.has(key)) {
        const oldInput = oldManifest.inputs.find((i) => i.key === key);
        const newInput = newManifest.inputs.find((i) => i.key === key);
        if (oldInput && newInput && (oldInput.type !== newInput.type || oldInput.required !== newInput.required)) {
          inputsChanged.push(key);
        }
      }
    }

    const outputsAdded = [...newOutputKeys].filter((k) => !oldOutputKeys.has(k));
    const outputsRemoved = [...oldOutputKeys].filter((k) => !newOutputKeys.has(k));

    const permissionsAdded = [...newGrantIds].filter((id) => !oldGrantIds.has(id));
    const permissionsRemoved = [...oldGrantIds].filter((id) => !newGrantIds.has(id));

    const oldIntents = new Set(oldManifest.triggers?.intents ?? []);
    const newIntents = new Set(newManifest.triggers?.intents ?? []);
    const oldPhrases = new Set(oldManifest.triggers?.phrases ?? []);
    const newPhrases = new Set(newManifest.triggers?.phrases ?? []);
    const oldChannels = new Set(oldManifest.triggers?.channels ?? []);
    const newChannels = new Set(newManifest.triggers?.channels ?? []);

    const breakingChanges: FridaySkillBreakingChange[] = [];

    for (const key of inputsRemoved) {
      const oldInput = oldManifest.inputs.find((i) => i.key === key);
      if (oldInput?.required) {
        breakingChanges.push({
          kind: "removed_required_input",
          detail: `Required input "${key}" was removed`,
        });
      }
    }
    for (const key of outputsRemoved) {
      breakingChanges.push({
        kind: "removed_output",
        detail: `Output "${key}" was removed`,
      });
    }

    const kindChanged = oldManifest.runtime.kind !== newManifest.runtime.kind;
    if (kindChanged) {
      breakingChanges.push({
        kind: "runtime_kind_change",
        detail: `Runtime kind changed from "${oldManifest.runtime.kind}" to "${newManifest.runtime.kind}"`,
      });
    }

    const oldModes = new Set<SkillInvocationMode>(oldManifest.invocation?.modes ?? []);
    const newModes = new Set<SkillInvocationMode>(newManifest.invocation?.modes ?? []);
    if (oldModes.has("workflow") && !newModes.has("workflow")) {
      breakingChanges.push({
        kind: "workflow_mode_removed",
        detail: 'Invocation mode "workflow" was removed from the new manifest',
      });
    }

    return {
      inputs: { added: inputsAdded, removed: inputsRemoved, changed: inputsChanged },
      outputs: { added: outputsAdded, removed: outputsRemoved },
      permissions: { added: permissionsAdded, removed: permissionsRemoved },
      triggers: {
        intentsAdded: [...newIntents].filter((i) => !oldIntents.has(i)),
        intentsRemoved: [...oldIntents].filter((i) => !newIntents.has(i)),
        phrasesAdded: [...newPhrases].filter((p) => !oldPhrases.has(p)),
        phrasesRemoved: [...oldPhrases].filter((p) => !newPhrases.has(p)),
        channelsAdded: [...newChannels].filter((c) => !oldChannels.has(c)),
        channelsRemoved: [...oldChannels].filter((c) => !newChannels.has(c)),
      },
      runtime: {
        kindChanged,
        entrypointChanged: oldManifest.runtime.entrypoint !== newManifest.runtime.entrypoint,
        oldKind: oldManifest.runtime.kind,
        newKind: newManifest.runtime.kind,
      },
      breakingChanges,
    };
  }

  function findAffectedWorkflows(skillId: string): FridaySkillAffectedWorkflow[] {
    return deps.db.withReadConnection((conn) => {
      const workflows = deps.workflowRepo.listWorkflows(conn, { limit: 1000 });
      const affected: FridaySkillAffectedWorkflow[] = [];

      for (const wf of workflows) {
        const version = deps.workflowRepo.getPublishedVersion(conn, wf.id)
          ?? deps.workflowRepo.getLatestVersion(conn, wf.id);
        if (!version) continue;
        if (!version.graphJson) {
          throw new FridayDomainError(
            "UPGRADE_WORKFLOW_GRAPH_PARSE_FAILED",
            `Cannot parse graph for workflow "${wf.name}" (${wf.id}): graphJson is missing on the selected version`,
            { httpStatus: 422 },
          );
        }

        let compiledGraph;
        try {
          compiledGraph = parseGraphJson(version.graphJson);
        } catch (e) {
          throw new FridayDomainError(
            "UPGRADE_WORKFLOW_GRAPH_PARSE_FAILED",
            `Cannot parse graph for workflow "${wf.name}" (${wf.id}): ${e instanceof Error ? e.message : String(e)}`,
            { httpStatus: 422 },
          );
        }

        const matchingNodes: FridaySkillAffectedWorkflowNodeDetail[] = [];
        for (const node of compiledGraph.graph.nodes) {
          const config = node.config as Record<string, unknown>;
          const effectiveRef = (config.skillId ?? config.ref) as string | undefined;
          if (effectiveRef === skillId) {
            const inputMapping = config.inputMapping as Record<string, unknown> | undefined;
            matchingNodes.push({
              nodeId: node.id,
              effectiveSkillRef: effectiveRef,
              inputMappingKeys: inputMapping ? Object.keys(inputMapping) : [],
            });
          }
        }
        if (matchingNodes.length > 0) {
          affected.push({ workflowId: wf.id, workflowName: wf.name, nodes: matchingNodes });
        }
      }

      return affected;
    });
  }

  function buildRegressionProof(
    affectedWorkflows: FridaySkillAffectedWorkflow[],
    newManifest: SkillManifestV2,
  ): FridaySkillWorkflowRegressionProof {
    if (affectedWorkflows.length === 0) {
      return { overallVerdict: "no_affected_workflows", entries: [] };
    }

    const newModes = new Set<SkillInvocationMode>(newManifest.invocation?.modes ?? []);
    const newInputKeys = new Set(newManifest.inputs.map((i) => i.key));
    const entries: FridaySkillWorkflowRegressionEntry[] = [];

    for (const wf of affectedWorkflows) {
      const failures: string[] = [];

      if (!newModes.has("workflow")) {
        failures.push(
          `Workflow "${wf.workflowName}" (${wf.workflowId}): new manifest does not include "workflow" invocation mode`,
        );
      }

      for (const node of wf.nodes) {
        for (const mappedKey of node.inputMappingKeys) {
          if (!newInputKeys.has(mappedKey)) {
            failures.push(
              `Workflow "${wf.workflowName}" node "${node.nodeId}": inputMapping key "${mappedKey}" is not present in candidate manifest inputs`,
            );
          }
        }
      }

      entries.push({
        workflowId: wf.workflowId,
        workflowName: wf.workflowName,
        nodes: wf.nodes,
        verdict: failures.length === 0 ? "pass" : "fail",
        failures,
      });
    }

    const overallVerdict = entries.every((e) => e.verdict === "pass") ? "pass" : "fail";
    return { overallVerdict, entries };
  }

  function computeRecommendation(
    comparisonReport: FridaySkillManifestComparisonReport,
    regressionProof: FridaySkillWorkflowRegressionProof,
  ): "replace" | "keep" | "review_required" {
    if (regressionProof.overallVerdict === "fail") {
      return "review_required";
    }
    if (comparisonReport.breakingChanges.length > 0 && regressionProof.entries.length > 0) {
      return "review_required";
    }
    return "replace";
  }

  function computeAnalysisDigest(
    analysis: Omit<FridaySkillUpgradeAnalysis, "analysisDigest">,
    candidateManifest: SkillManifestV2,
    existingManifest: SkillManifestV2 | null,
  ): string {
    const payload = {
      skillId: analysis.skillId,
      candidateId: analysis.candidateId,
      isDuplicate: analysis.isDuplicate,
      existingVersion: analysis.existingVersion,
      candidateVersion: analysis.candidateVersion,
      comparisonReport: analysis.comparisonReport,
      affectedWorkflows: analysis.affectedWorkflows,
      regressionProof: analysis.regressionProof,
      recommendation: analysis.recommendation,
      rollbackPointer: analysis.rollbackPointer,
      candidateManifestDigest: manifestDigest(candidateManifest),
      previousManifestDigest: existingManifest ? manifestDigest(existingManifest) : null,
    };
    return createHash("sha256").update(stableStringify(payload)).digest("hex");
  }

  function manifestDigest(manifest: SkillManifestV2): string {
    return createHash("sha256")
      .update(stableStringify(manifest))
      .digest("hex");
  }

  return {
    analyze(input) {
      const existing = deps.db.withReadConnection((conn) =>
        deps.skillRepo.getSkillById(conn, input.skillId),
      );

      const isDuplicate = Boolean(
        existing && existing.installedVersion && existing.currentManifest,
      );

      const { manifest: candidateManifest } = resolveAndLoadCandidate(input.skillId, input.candidateId);

      let comparisonReport: FridaySkillManifestComparisonReport | null = null;
      if (isDuplicate && existing!.currentManifest) {
        comparisonReport = compareManifests(existing!.currentManifest, candidateManifest);
      }

      const affectedWorkflows = findAffectedWorkflows(input.skillId);

      const regressionProof = comparisonReport
        ? buildRegressionProof(affectedWorkflows, candidateManifest)
        : { overallVerdict: "no_affected_workflows" as const, entries: [] };

      const recommendation = comparisonReport
        ? computeRecommendation(comparisonReport, regressionProof)
        : "replace";

      const rollbackPointer = {
        available: Boolean(existing?.installedVersion),
        previousVersion: existing?.installedVersion ?? null,
        previousManifestDigest: existing?.currentManifest
          ? manifestDigest(existing.currentManifest)
          : null,
      };

      const partial = {
        skillId: input.skillId,
        candidateId: input.candidateId,
        isDuplicate,
        existingVersion: existing?.installedVersion ?? null,
        candidateVersion: candidateManifest.version,
        comparisonReport,
        affectedWorkflows,
        regressionProof,
        recommendation,
        rollbackPointer,
        analyzedAt: deps.nowIso(),
      };

      const analysisDigest = computeAnalysisDigest(partial, candidateManifest, existing?.currentManifest ?? null);

      return { ...partial, analysisDigest };
    },

    applyDecision(input) {
      const { candidate } = resolveAndLoadCandidate(input.skillId, input.candidateId);

      const existing = deps.db.withReadConnection((conn) =>
        deps.skillRepo.getSkillById(conn, input.skillId),
      );
      if (!existing || !existing.installedVersion) {
        throw new FridayDomainError(
          "UPGRADE_SKILL_NOT_INSTALLED",
          `Skill ${input.skillId} is not installed; cannot apply upgrade decision`,
          { httpStatus: 409 },
        );
      }

      const currentAnalysis = this.analyze({ skillId: input.skillId, candidateId: input.candidateId });
      if (currentAnalysis.analysisDigest !== input.analysisDigest) {
        throw new FridayDomainError(
          "UPGRADE_ANALYSIS_DIGEST_MISMATCH",
          "The analysis has changed since the approval was granted; re-analyze before deciding",
          { httpStatus: 409 },
        );
      }

      if (input.decision === "replace") {
        deps.db.withWriteTransaction((conn) => {
          deps.skillRepo.updateLifecycleStatus(conn, input.skillId, "upgrade_available", deps.nowIso());
        });
      }

      return {
        decision: input.decision,
        skillId: input.skillId,
        candidateId: input.candidateId,
        analysisDigest: input.analysisDigest,
        decidedAt: deps.nowIso(),
        approvalProof: {
          ticketId: input.ticket.ticketId,
          actionDigest: input.ticket.actionDigest,
          action: input.ticket.action,
          resource: { type: input.ticket.resource.type, id: input.ticket.resource.id ?? input.skillId },
          risk: input.ticket.risk,
          approvedByPrincipalId: input.ticket.approvedByPrincipalId,
          issuedAt: input.ticket.issuedAt,
        },
      };
    },
  };
}
