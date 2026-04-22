import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayAgentRunRecord,
  FridaySubagentRegistry,
  FridaySubagentRunRecord,
  FridaySubagentRunStatus,
} from "#agent";
import { FridayDomainError } from "#errors";
import { FRIDAY_SUBAGENT_ERROR_CODES } from "#agent";

// ─── Constants ───

const SUBAGENT_MAX_LIST_LIMIT = 100;
const CUSTOM_PACK_INTERNAL_DETAIL_PATTERNS: ReadonlyArray<RegExp> = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /[（(]?\s*ID\s*[:：]/i,
  /\b(?:readOnly|skills_list|memory_search|agents_list|sub-?agent|sessionKey|session key|childRunId|tool[_ ]call|tool name|pack_id|pack id|memory system|memory item|memory namespace)\b/i,
  /\b(?:run id|session id|subagent id)\b/i,
  /(?:任务包\s*id|只读模式|内存(?:系统|持久化|记录)|记忆(?:系统|条目|检索)|工作流目录|workflow catalog|子代理|会话键|父会话|父子会话|运行深度|元数据)/i,
];
const CUSTOM_PACK_INTERNAL_LINE_DROP_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:只读模式|read[- ]?only mode)/i,
  /(?:内存(?:系统|持久化|记录)|记忆(?:系统|条目|检索)|memory system|memory item|memory namespace|memory search)/i,
  /(?:skills_list|memory_search|agents_list|sub-?agent|tool[_ ]call|tool name)/i,
  /(?:子代理|会话键|父会话|父子会话|运行深度|元数据)/i,
  /(?:当前运行.*正在执行中)/i,
];
const CUSTOM_PACK_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// ─── Deps ───

export interface FridaySubagentRoutesDeps {
  subagentRegistry: FridaySubagentRegistry;
  getRun?: (runId: string) => FridayAgentRunRecord | null;
}

function isCustomPackRun(run: FridayAgentRunRecord | null | undefined): boolean {
  return Boolean(run?.metadata?.packContext?.packId?.trim().startsWith("custom-"));
}

function sanitizeCustomPackSubagentOutcome(responseText: string): string {
  const filteredLines = responseText
    .split("\n")
    .map((line) =>
      line
        .replace(/(?:任务包\s*id|pack(?:\s|_)?id|run(?:\s|_)?id|session(?:\s|_)?id|session(?:\s|_)?key)\s*[:：=]\s*[^\s,，;；)）]+/giu, "")
        .replace(/\b(?:readOnly|readonly)\b\s*(?:[:=]\s*(?:true|false))?/giu, "")
        .replace(/\b(?:skills_list|memory_search|agents_list|sub-agent|subagent|sessionKey|childRunId|tool[_ ]call|tool name)\b/giu, "")
        .replace(CUSTOM_PACK_UUID_RE, "")
        .replace(/[（(]\s*ID\s*[:：]\s*[）)]/giu, "")
        .replace(/\bID\s*[:：]\s*/giu, "")
        .replace(/[（(]\s*[）)]/gu, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .filter((line) => !/^(?:[-*•]\s*|(?:\d+[.)]\s*))$/u.test(line))
    .filter((line) => !CUSTOM_PACK_INTERNAL_LINE_DROP_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !CUSTOM_PACK_INTERNAL_DETAIL_PATTERNS.some((pattern) => pattern.test(line)));

  const sanitized = filteredLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return sanitized.length > 0
    ? sanitized
    : "这次自创任务已经完成，结果已按真实任务定义和真实运行记录整理。";
}

function sanitizeSubagentRecord(
  record: FridaySubagentRunRecord,
  hideInternalOutcomeDetails: boolean,
): FridaySubagentRunRecord {
  if (!hideInternalOutcomeDetails || !record.outcome?.response) {
    return record;
  }
  return {
    ...record,
    outcome: {
      ...record.outcome,
      response: sanitizeCustomPackSubagentOutcome(record.outcome.response),
    },
  };
}

// ─── Factory ───

export function createFridaySubagentRoutes(
  deps: FridaySubagentRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    // ─── GET /v1/agent/subagents ───
    {
      operationId: "agent.subagents.list",
      method: "GET",
      path: "/v1/agent/subagents",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const query = ctx.query as Record<string, string | undefined>;

        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "limit must be a positive integer",
              { httpStatus: 400 },
            );
          }
          limit = Math.min(parsed, SUBAGENT_MAX_LIST_LIMIT);
        }

        const parentRunId = query.parentRunId;
        const status = query.status as FridaySubagentRunStatus | undefined;

        const items = deps.subagentRegistry.list({
          parentRunId,
          status,
          limit,
          cursor: query.cursor,
        });

        return {
          items: items.map((record) =>
            sanitizeSubagentRecord(
              record,
              isCustomPackRun(deps.getRun?.(record.parentRunId)),
            ),
          ),
        };
      },
    },

    // ─── GET /v1/agent/subagents/:subagentId ───
    {
      operationId: "agent.subagents.get",
      method: "GET",
      path: "/v1/agent/subagents/:subagentId",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const { subagentId } = ctx.params as { subagentId: string };
        const subagent = deps.subagentRegistry.getById(subagentId);
        if (!subagent) {
          throw new FridayDomainError(
            FRIDAY_SUBAGENT_ERROR_CODES.NOT_FOUND,
            "Sub-agent not found",
            { httpStatus: 404 },
          );
        }
        return {
          subagent: sanitizeSubagentRecord(
            subagent,
            isCustomPackRun(deps.getRun?.(subagent.parentRunId)),
          ),
        };
      },
    },

    // ─── GET /v1/agent/runs/:runId/subagents ───
    {
      operationId: "agent.runs.subagents.list",
      method: "GET",
      path: "/v1/agent/runs/:runId/subagents",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const items = deps.subagentRegistry.listByParentRunId(runId);
        const hideInternalOutcomeDetails = isCustomPackRun(deps.getRun?.(runId));
        return {
          items: items.map((record) => sanitizeSubagentRecord(record, hideInternalOutcomeDetails)),
        };
      },
    },
  ];
}
