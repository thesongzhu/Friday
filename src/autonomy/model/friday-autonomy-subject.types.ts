import type { FridayAutonomyUpgradeFields } from "./friday-autonomy-upgrade.types.js";

export type FridayAutonomySubjectKind =
  | "skill"
  | "workflow"
  | "plugin"
  | "provider_profile"
  | "mcp_server"
  | "channel_adapter";

export interface FridayAutonomySubjectRecord extends FridayAutonomyUpgradeFields {
  kind: FridayAutonomySubjectKind;
  id: string;
  displayName: string;
  status: string;
  activeVersion?: string;
  details?: Record<string, unknown>;
}
