import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V050_AGENT_LOOP_EXPERT_AUTONOMY_SQL = `
-- V050: bounded expert autonomy for the agent loop.

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN expert_mode_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN expert_mode_user_ids_json TEXT;

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN expert_mode_workspace_ids_json TEXT;

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN expert_mode_environments_json TEXT;

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN context_inference_allowed INTEGER NOT NULL DEFAULT 1;

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN multi_step_hypothesis_search_allowed INTEGER NOT NULL DEFAULT 1;

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN safe_probe_execution_allowed INTEGER NOT NULL DEFAULT 1;

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN cross_surface_orchestration_allowed INTEGER NOT NULL DEFAULT 1;

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN high_risk_final_approval_required INTEGER NOT NULL DEFAULT 1;

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN production_destructive_action_approval_required INTEGER NOT NULL DEFAULT 1;

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN probe_budget INTEGER NOT NULL DEFAULT 4;

ALTER TABLE friday_agent_loop_policy
  ADD COLUMN time_budget_minutes INTEGER NOT NULL DEFAULT 20;

ALTER TABLE friday_agent_loop_runs
  ADD COLUMN expert_mode_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE friday_agent_loop_runs
  ADD COLUMN risk_class TEXT;

ALTER TABLE friday_agent_loop_runs
  ADD COLUMN requires_final_approval INTEGER NOT NULL DEFAULT 0;

ALTER TABLE friday_agent_loop_runs
  ADD COLUMN assumptions_json TEXT;

ALTER TABLE friday_agent_loop_runs
  ADD COLUMN unknowns_json TEXT;

ALTER TABLE friday_agent_loop_runs
  ADD COLUMN hypotheses_json TEXT;

ALTER TABLE friday_agent_loop_runs
  ADD COLUMN probe_steps_json TEXT;

ALTER TABLE friday_agent_loop_runs
  ADD COLUMN probe_budget INTEGER;

ALTER TABLE friday_agent_loop_runs
  ADD COLUMN objective TEXT;

ALTER TABLE friday_agent_loop_runs
  ADD COLUMN plan_summary TEXT;
`;

const V050_CHECKSUM = computeFridayMigrationChecksum(V050_AGENT_LOOP_EXPERT_AUTONOMY_SQL);

export const V050_AGENT_LOOP_EXPERT_AUTONOMY_MIGRATION: FridaySqliteMigration = {
  version: 50,
  name: "v050-agent-loop-expert-autonomy",
  sql: V050_AGENT_LOOP_EXPERT_AUTONOMY_SQL,
  checksum: V050_CHECKSUM,
};
