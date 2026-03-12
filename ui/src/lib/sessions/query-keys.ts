import type { FridaySessionStatus } from "@/lib/api/types";

export const sessionKeys = {
  all: ["sessions"] as const,

  list: (filters?: {
    status?: FridaySessionStatus;
    channel?: string;
    accountId?: string;
    userId?: string;
  }) => [...sessionKeys.all, "list", filters ?? {}] as const,

  detail: (sessionKey: string) =>
    [...sessionKeys.all, "detail", sessionKey] as const,

  messages: (sessionKey: string) =>
    [...sessionKeys.all, "messages", sessionKey] as const,

  memoryNamespace: (sessionKey: string) =>
    [...sessionKeys.all, "memory-namespace", sessionKey] as const,

  forks: (sessionKey: string) =>
    [...sessionKeys.all, "forks", sessionKey] as const,

  extractionStatus: (sessionKey: string) =>
    [...sessionKeys.all, "extraction-status", sessionKey] as const,
};
