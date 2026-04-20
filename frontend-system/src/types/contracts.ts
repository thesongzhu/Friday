export type PageId =
  | "home"
  | "chat"
  | "assistant"
  | "workflows"
  | "automations"
  | "memory"
  | "integrations"
  | "observability"
  | "fleet"
  | "settings";

export type SurfaceName =
  | "Home"
  | "Chat"
  | "Assistant"
  | "Workflows"
  | "Automations"
  | "Memory"
  | "Integrations"
  | "Observability"
  | "Fleet"
  | "Settings";

export type PreviewState = "loading" | "empty" | "error" | "partial" | "success";

export interface DesignTokenContract {
  colors: Record<string, string>;
  typography: Record<string, string | number>;
  spacing: Record<string, string>;
  radius: Record<string, string>;
  shadow: Record<string, string>;
  motion: Record<string, string>;
}

export interface CapabilityManifest {
  capabilityId: string;
  userValue: string;
  primarySurface: SurfaceName;
  secondarySurface: SurfaceName;
  layoutSlot: string;
  defaultVisibility: "primary" | "secondary" | "advanced" | "diagnostic";
  desktopPlacement: string;
  mobilePlacement: string;
  requiresChatContext: boolean;
  dataDependencies: string[];
}

export interface ShellContextContract {
  sourcePage: PageId;
  objectType: string;
  objectId?: string;
  summary: string;
  injections: string[];
  quickActions: string[];
}

export interface LayoutModule {
  id: string;
  title: string;
  purpose: string;
  placement: string;
  actions: string[];
}

export interface PageBlueprint {
  id: PageId;
  title: string;
  audience: string[];
  tasks: string[];
  modules: LayoutModule[];
  desktopLayout: string[];
  mobileMapping: string[];
  rightRailContext: ShellContextContract;
  states: Record<PreviewState, string>;
  prohibitions: string[];
}

export interface PreviewMetric {
  title: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}

export interface PreviewFixture {
  id: string;
  page: PageId;
  title: string;
  scenario: string;
  status: PreviewState;
  modules: PreviewMetric[];
  rightRailSummary: string[];
}

export interface ShellNavItem {
  id: PageId;
  label: string;
}
