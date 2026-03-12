export type SkillLifecycleStatus =
  | "not_installed"
  | "installed"
  | "disabled"
  | "error"
  | "upgrade_available";

export type SkillLifecycleOperation =
  | "discover"
  | "install"
  | "verify"
  | "activate"
  | "disable"
  | "enable"
  | "update"
  | "uninstall"
  | "mark_error"
  | "detect_upgrade"
  | "clear_upgrade";

export interface FridaySkillLifecycleTransition {
  from: SkillLifecycleStatus;
  operation: SkillLifecycleOperation;
  to: SkillLifecycleStatus;
}
