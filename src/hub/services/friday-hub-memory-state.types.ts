import type { SkillLifecycleStatus, SkillManifestV2, SkillOrigin, SkillSource } from "#skills";

export interface FridayDiscoveredSkillRecord {
  id: string;
  name: string;
  source: SkillSource;
  origin: SkillOrigin;
  status: SkillLifecycleStatus;
  manifest: SkillManifestV2;
  latestVersion?: string;
  installedVersion?: string;
}

export interface FridayAuditLogWrite {
  id: string;
  ts: string;
  actorType: "user" | "satellite" | "service" | "workflow-runner";
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  requestId?: string;
  traceId?: string;
  /** Outcome taxonomy. */
  result?: "success" | "failure" | "denied" | "error";
  /** Machine-readable error code (when result is "error" or "denied"). */
  errorCode?: string;
  /** Human-readable error description. */
  errorMessage?: string;
  /** Caller identifier (function, module, service). */
  caller?: string;
  details?: Record<string, unknown>;
}

export interface FridayConversationSessionRecord {
  id: string;
  sessionKey: string;
  agentId: string;
  channel: string;
  chatKind: "dm" | "group" | "channel" | "thread";
  ownerLeaseEpoch: number;
  status: "active" | "idle" | "archived";
  summary?: string;
}

export interface FridaySessionMessageWrite {
  sessionId: string;
  leaseEpoch: number;
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  sourceSatelliteId?: string;
  idempotencyKey?: string;
}

export interface FridaySessionMessageRecord extends FridaySessionMessageWrite {
  id: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface FridayMemoryItemRecord {
  id: string;
  namespace: string;
  key: string;
  value: unknown;
  tags: string[];
  updatedAt: string;
}

export interface FridayHubMemoryStateService {
  listSkillStatuses(): Promise<Record<string, SkillLifecycleStatus>>;
  upsertDiscoveredSkills(records: FridayDiscoveredSkillRecord[]): Promise<void>;
  updateSkillStatus(skillId: string, status: SkillLifecycleStatus, reason?: string): Promise<void>;
  appendAuditLog(entry: FridayAuditLogWrite): Promise<void>;
  getSession(sessionId: string): Promise<FridayConversationSessionRecord | null>;
  appendSessionMessage(input: FridaySessionMessageWrite): Promise<FridaySessionMessageRecord>;
  getMemoryItems(namespace: string, keys?: string[]): Promise<FridayMemoryItemRecord[]>;
  putMemoryItem(item: {
    namespace: string;
    key: string;
    value: unknown;
    tags?: string[];
  }): Promise<void>;
}
