import type { FridayMemoryItem, FridayMemoryService } from "#memory";
import type {
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowCrudService,
  FridayWorkflowExecutionService,
  FridayWorkflowRunEntity,
  FridayWorkflowVersionEntity,
  JsonObject,
} from "#workflows";

const DEFAULT_MEMORY_NAMESPACES = ["agent", "default"] as const;
const SAFE_RISK_TIERS = new Set(["low", "low-risk", "noop", "no-op", "safe"]);
const SAFE_WORKFLOW_TAGS = new Set(["safe-natural-trigger", "low-risk", "no-op", "noop", "phase24h-natural-trigger"]);
const DESTRUCTIVE_OR_UNSAFE_RE =
  /\b(delete|remove|erase|destroy|drop|wipe|purge|send|email|message\s+every|charge|pay|purchase|buy|spend|credential|secret|token|api\s*key|config|settings|filesystem|file\s+system|irreversible)\b|(?:删除|清空|销毁|抹掉|发送|群发|付款|购买|花费|密钥|凭据|配置|文件系统|不可逆)/iu;

function uniqueMemoryItems(items: FridayMemoryItem[]): FridayMemoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export type FridayChannelNaturalTriggerResolution =
  | {
      handled: false;
      reason: "no_binding";
    }
  | {
      handled: true;
      action: "executed";
      workflowId: string;
      workflowVersionId?: string;
      workflowRun: FridayWorkflowRunEntity;
      memoryItemId: string;
      replyText: string;
      diagnostics: FridayChannelNaturalTriggerDiagnostics;
    }
  | {
      handled: true;
      action: "confirmation_required" | "approval_required" | "execution_pending" | "execution_failed" | "refused";
      replyText: string;
      diagnostics: FridayChannelNaturalTriggerDiagnostics;
    };

export interface FridayChannelNaturalTriggerDiagnostics {
  reason: string;
  memoryItemId?: string;
  workflowId?: string;
  workflowVersionId?: string;
  matchedTrigger?: string;
  nearMatchTrigger?: string;
  workflowDiscoveryOccurred: boolean;
  memoryRecallOccurred: boolean;
  riskTier?: string;
}

export interface FridayNaturalTriggerBinding {
  triggers: string[];
  workflowId?: string;
  workflowVersionId?: string;
  riskTier?: string;
  approved?: boolean;
}

export interface FridayChannelNaturalTriggerResolverDeps {
  memoryService: FridayMemoryService;
  workflowCrudService: FridayWorkflowCrudService;
  workflowExecutionService: FridayWorkflowExecutionService;
  getSessionMemoryNamespace?: (sessionKey: string) => Promise<string>;
  startedByUserId: string;
  nowIso: () => string;
}

export interface ResolveFridayChannelNaturalTriggerInput {
  text: string;
  sessionKey: string;
  channelKind: string;
  chatId: string;
  senderId?: string;
}

function normalizeTriggerText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTriggerList(value: string): string[] {
  return value
    .split(/\s*(?:;|\||\n)\s*/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readMetadataBinding(item: FridayMemoryItem): FridayNaturalTriggerBinding | null {
  const metadata = item.metadata ?? {};
  const raw = metadata.naturalTriggerBinding ?? metadata.naturalTrigger;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const triggers = Array.isArray(record.triggers)
    ? record.triggers.filter((trigger): trigger is string => typeof trigger === "string" && trigger.trim().length > 0)
    : typeof record.trigger === "string"
      ? [record.trigger]
      : [];
  return {
    triggers,
    workflowId: typeof record.workflowId === "string" ? record.workflowId : undefined,
    workflowVersionId: typeof record.workflowVersionId === "string" ? record.workflowVersionId : undefined,
    riskTier: typeof record.riskTier === "string" ? record.riskTier : undefined,
    approved: record.approved === true,
  };
}

function readTextBinding(item: FridayMemoryItem): FridayNaturalTriggerBinding | null {
  const content = item.content;
  const triggerLine = /(?:approved\s+triggers?|trigger\s+phrases?)\s*[:：]\s*([^\n]+)/iu.exec(content)?.[1];
  const workflowId =
    /(?:workflow(?:\s+id)?|workflow)\s*[:：=]\s*([a-z0-9][a-z0-9_.:-]{5,})/iu.exec(content)?.[1];
  const workflowVersionId =
    /(?:version(?:\s+id)?|workflow\s+version)\s*[:：=]\s*([a-z0-9][a-z0-9_.:-]{5,})/iu.exec(content)?.[1];
  const riskTier =
    /(?:risk(?:\s+tier)?|risk)\s*[:：=]\s*([a-z0-9_-]+)/iu.exec(content)?.[1];

  if (!triggerLine && !workflowId) {
    return null;
  }
  return {
    triggers: triggerLine ? splitTriggerList(triggerLine) : [],
    workflowId,
    workflowVersionId,
    riskTier,
    approved: /\bapproved\b|已批准|已审核/u.test(content),
  };
}

function readBinding(item: FridayMemoryItem): FridayNaturalTriggerBinding | null {
  const metadataBinding = readMetadataBinding(item);
  const textBinding = readTextBinding(item);
  if (!metadataBinding && !textBinding) {
    return null;
  }
  return {
    triggers: [
      ...(metadataBinding?.triggers ?? []),
      ...(textBinding?.triggers ?? []),
    ],
    workflowId: metadataBinding?.workflowId ?? textBinding?.workflowId,
    workflowVersionId: metadataBinding?.workflowVersionId ?? textBinding?.workflowVersionId,
    riskTier: metadataBinding?.riskTier ?? textBinding?.riskTier,
    approved: metadataBinding?.approved === true || textBinding?.approved === true,
  };
}

function tokenSimilarity(a: string, b: string): number {
  const aTokens = new Set(normalizeTriggerText(a).split(" ").filter(Boolean));
  const bTokens = new Set(normalizeTriggerText(b).split(" ").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  return intersection / Math.max(aTokens.size, bTokens.size);
}

function containsNormalizedTrigger(inputText: string, triggerText: string): boolean {
  if (!inputText || !triggerText) return false;
  return ` ${inputText} `.includes(` ${triggerText} `);
}

function isGraphLowRisk(graph: unknown): boolean {
  const nodes = (graph as Partial<FridayCompiledWorkflowGraphV2> | undefined)?.graph?.nodes;
  if (!Array.isArray(nodes)) {
    return false;
  }
  return nodes.every((node) => {
    if (!node || typeof node !== "object") return false;
    const type = (node as { type?: unknown }).type;
    return type === "trigger" || type === "data" || type === "condition" || type === "transform";
  });
}

function isWorkflowLowRisk(input: {
  workflowTags: string[];
  bindingRiskTier?: string;
  version: FridayWorkflowVersionEntity | null;
}): boolean {
  const riskTier = input.bindingRiskTier?.trim().toLowerCase();
  const bindingAllows = riskTier ? SAFE_RISK_TIERS.has(riskTier) : false;
  const tagAllows = input.workflowTags.some((tag) => SAFE_WORKFLOW_TAGS.has(tag.trim().toLowerCase()));
  return (bindingAllows || tagAllows) && isGraphLowRisk(input.version?.graphJson);
}

function buildReplyText(input: {
  action: "executed" | "confirmation_required" | "approval_required" | "execution_pending" | "execution_failed" | "refused";
  workflowName?: string;
  matchedTrigger?: string;
  runId?: string;
}): string {
  if (input.action === "executed") {
    return `Done. I found the approved automation${input.workflowName ? ` "${input.workflowName}"` : ""}, ran it safely, and saved the run evidence.`;
  }
  if (input.action === "confirmation_required") {
    return "I found a nearby approved automation, but this wording is not an exact saved trigger. Please confirm the exact automation you want me to run before I start anything.";
  }
  if (input.action === "approval_required") {
    return "I found the approved automation, but this request is not safe for automatic channel execution. Please approve it explicitly before I start anything.";
  }
  if (input.action === "execution_pending") {
    return "I found the approved automation and started it safely, but it is still running. I will not mark it complete until the workflow finishes and evidence is available.";
  }
  if (input.action === "execution_failed") {
    return "I found the approved automation and started it safely, but the workflow did not complete successfully. No success was recorded.";
  }
  return "I cannot run that from chat because it asks for a destructive or unsafe action. No workflow was started.";
}

async function waitForTerminalWorkflowRun(
  executionService: FridayWorkflowExecutionService,
  runId: string,
): Promise<FridayWorkflowRunEntity | null> {
  const deadline = Date.now() + 10_000;
  const transient = new Set(["queued", "running", "pausing"]);
  while (Date.now() < deadline) {
    const run = executionService.getRun(runId);
    if (run && !transient.has(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

export function createFridayChannelNaturalTriggerResolver(
  deps: FridayChannelNaturalTriggerResolverDeps,
) {
  return {
    async resolve(input: ResolveFridayChannelNaturalTriggerInput): Promise<FridayChannelNaturalTriggerResolution> {
      const normalizedText = normalizeTriggerText(input.text);
      if (!normalizedText) {
        return { handled: false, reason: "no_binding" };
      }

      const sessionNamespace = await deps.getSessionMemoryNamespace?.(input.sessionKey).catch(() => undefined);
      const namespaces = [...new Set([
        ...(sessionNamespace ? [sessionNamespace] : []),
        ...DEFAULT_MEMORY_NAMESPACES,
      ])];
      const memoryResults = await deps.memoryService.search(input.text, {
        namespace: namespaces,
        tagsAny: ["approved-workflow-trigger", "natural-trigger", "sop", "workflow"],
        memoryType: ["procedure"],
        limit: 10,
        boostByConfidence: true,
      }).catch(() => []);
      const listedItems = await deps.memoryService.list({
        namespace: namespaces,
        tagsAny: ["approved-workflow-trigger", "natural-trigger", "sop", "workflow"],
        limit: 20,
      }).catch(() => []);
      const listedMemories = uniqueMemoryItems([
        ...memoryResults.map((result) => result.item),
        ...listedItems,
      ]);

      let bestNearMatch: { item: FridayMemoryItem; binding: FridayNaturalTriggerBinding; trigger: string; score: number } | null = null;
      for (const item of listedMemories) {
        const binding = readBinding(item);
        if (!binding?.approved || !binding.workflowId || binding.triggers.length === 0) {
          continue;
        }
        for (const trigger of binding.triggers) {
          const normalizedTrigger = normalizeTriggerText(trigger);
          if (normalizedTrigger === normalizedText) {
            const workflow = deps.workflowCrudService.getWorkflow(binding.workflowId);
            const version = binding.workflowVersionId
              ? deps.workflowCrudService.getVersion(binding.workflowVersionId)
              : deps.workflowCrudService.getPublishedVersion(binding.workflowId);
            const diagnostics: FridayChannelNaturalTriggerDiagnostics = {
              reason: "exact_approved_binding",
              memoryItemId: item.id,
              workflowId: binding.workflowId,
              workflowVersionId: version?.id ?? binding.workflowVersionId,
              matchedTrigger: trigger,
              workflowDiscoveryOccurred: Boolean(workflow),
              memoryRecallOccurred: true,
              riskTier: binding.riskTier,
            };
            const versionIsPublished =
              Boolean(version?.isPublished)
              && version?.workflowId === workflow?.id
              && workflow?.publishedVersionNumber === version?.versionNumber;
            if (!workflow || !version || workflow.isArchived || !versionIsPublished) {
              return {
                handled: true,
                action: "confirmation_required",
                replyText: "I found a saved trigger, but the approved workflow is not currently published. I did not start anything.",
                diagnostics: { ...diagnostics, reason: "workflow_not_published" },
              };
            }
            if (DESTRUCTIVE_OR_UNSAFE_RE.test(input.text)) {
              return {
                handled: true,
                action: "refused",
                replyText: buildReplyText({ action: "refused" }),
                diagnostics: { ...diagnostics, reason: "unsafe_request_refused" },
              };
            }
            if (!isWorkflowLowRisk({ workflowTags: workflow.tags, bindingRiskTier: binding.riskTier, version })) {
              return {
                handled: true,
                action: "approval_required",
                replyText: buildReplyText({ action: "approval_required" }),
                diagnostics: { ...diagnostics, reason: "workflow_requires_approval" },
              };
            }

            const started = await deps.workflowExecutionService.startRun({
              workflowId: workflow.id,
              workflowVersionId: version.id,
              triggerType: "channel_natural_trigger",
              triggerPayload: {
                triggerPhrase: input.text,
                matchedTrigger: trigger,
                memoryItemId: item.id,
                channelKind: input.channelKind,
                chatId: input.chatId,
              } as JsonObject,
              context: {
                source: "channel_natural_trigger_resolver",
                memoryItemId: item.id,
              },
              startedByUserId: deps.startedByUserId,
              proofRequired: true,
            });
            const workflowRun = await waitForTerminalWorkflowRun(deps.workflowExecutionService, started.id);
            if (!workflowRun) {
              return {
                handled: true,
                action: "execution_pending",
                replyText: buildReplyText({ action: "execution_pending", workflowName: workflow.name, runId: started.id }),
                diagnostics: { ...diagnostics, reason: "workflow_execution_still_running" },
              };
            }
            if (workflowRun.status !== "completed") {
              return {
                handled: true,
                action: "execution_failed",
                replyText: buildReplyText({ action: "execution_failed", workflowName: workflow.name, runId: workflowRun.id }),
                diagnostics: { ...diagnostics, reason: "workflow_execution_not_successful" },
              };
            }
            return {
              handled: true,
              action: "executed",
              workflowId: workflow.id,
              workflowVersionId: version.id,
              workflowRun,
              memoryItemId: item.id,
              replyText: buildReplyText({ action: "executed", workflowName: workflow.name, runId: workflowRun.id }),
              diagnostics,
            };
          }

          const containsTrigger = containsNormalizedTrigger(normalizedText, normalizedTrigger);
          const score = containsTrigger ? 0.99 : tokenSimilarity(input.text, trigger);
          if (score >= 0.55 && (!bestNearMatch || score > bestNearMatch.score)) {
            bestNearMatch = { item, binding, trigger, score };
          }
        }
      }

      if (bestNearMatch) {
        if (DESTRUCTIVE_OR_UNSAFE_RE.test(input.text)) {
          return {
            handled: true,
            action: "refused",
            replyText: buildReplyText({ action: "refused" }),
            diagnostics: {
              reason: "unsafe_request_refused",
              memoryItemId: bestNearMatch.item.id,
              workflowId: bestNearMatch.binding.workflowId,
              workflowVersionId: bestNearMatch.binding.workflowVersionId,
              nearMatchTrigger: bestNearMatch.trigger,
              workflowDiscoveryOccurred: false,
              memoryRecallOccurred: true,
              riskTier: bestNearMatch.binding.riskTier,
            },
          };
        }
        return {
          handled: true,
          action: "confirmation_required",
          replyText: buildReplyText({ action: "confirmation_required" }),
          diagnostics: {
            reason: "near_match_requires_confirmation",
            memoryItemId: bestNearMatch.item.id,
            workflowId: bestNearMatch.binding.workflowId,
            workflowVersionId: bestNearMatch.binding.workflowVersionId,
            nearMatchTrigger: bestNearMatch.trigger,
            workflowDiscoveryOccurred: false,
            memoryRecallOccurred: true,
            riskTier: bestNearMatch.binding.riskTier,
          },
        };
      }

      return { handled: false, reason: "no_binding" };
    },
  };
}
