import type { NodeAttemptStatus } from "@/lib/api/types";

export const workflowKeys = {
  all: ["workflows"] as const,

  list: (filters?: { tag?: string; archived?: boolean }) =>
    [...workflowKeys.all, "list", filters ?? {}] as const,

  detail: (workflowId: string) =>
    [...workflowKeys.all, "detail", workflowId] as const,

  versions: (workflowId: string) =>
    [...workflowKeys.all, "versions", workflowId] as const,

  drafts: (workflowId: string) =>
    [...workflowKeys.all, "drafts", workflowId] as const,

  draft: (workflowId: string, draftId: string) =>
    [...workflowKeys.all, "draft", workflowId, draftId] as const,

  run: (runId: string) =>
    ["workflow-run", runId] as const,

  runNodes: (runId: string, status?: NodeAttemptStatus) =>
    ["workflow-run-nodes", runId, status ?? "all"] as const,

  runTimeline: (runId: string) =>
    ["workflow-run-timeline", runId] as const,

  generatorSession: (sessionId: string) =>
    ["workflow-generator-session", sessionId] as const,
};
