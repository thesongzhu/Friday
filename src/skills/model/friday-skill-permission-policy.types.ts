export type PermissionResource =
  | "filesystem"
  | "network"
  | "channel"
  | "tool"
  | "memory"
  | "device"
  | "shell";

export type PermissionAction =
  | "read"
  | "write"
  | "connect"
  | "send"
  | "receive"
  | "execute"
  | "capture";

export interface PermissionSelectors {
  pathPrefixes?: string[];
  hostAllowlist?: string[];
  channelIds?: string[];
  toolAllowlist?: string[];
  commandAllowlist?: string[];
  memoryNamespaces?: string[];
}

export interface PermissionGrant {
  id: string;
  resource: PermissionResource;
  action: PermissionAction;
  required: boolean;
  reason: string;
  selectors?: PermissionSelectors;
}

export type PermissionPromptToken =
  | "filesystem.write"
  | "network.connect"
  | "shell.execute"
  | "channel.send"
  | "device.capture";

export interface PermissionPolicyV2 {
  grants: PermissionGrant[];
  promptOn: PermissionPromptToken[];
}

export interface LegacySkillPermissionV1 {
  tools: string[];
  memoryScope: "none" | "read" | "readwrite";
  network: boolean;
  filesystem: "none" | "workspace" | "scoped";
  filesystemScopes?: string[];
}
