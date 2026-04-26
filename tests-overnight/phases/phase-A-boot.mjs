// Phase A — boot baseline: snapshot DB row counts; verify health/setup/providers/jobs.
import Database from "better-sqlite3";
import { api, log, startPhase, STATE_DIR } from "../lib/util.mjs";

const TABLES = [
  "memory_items","memory_embeddings","sessions","session_messages","friday_agent_runs","friday_agent_run_events",
  "friday_episodes","friday_world_state_snapshots","friday_world_entities",
  "learning_events","learned_lessons","error_incidents","diagnosis_records","auto_fix_actions",
  "audit_logs","obs_audit_entries",
  "skill_installations","skill_versions","skills","preference_facts",
  "friday_standing_goals","friday_agenda_items","friday_agenda_runs",
  "friday_capability_acquisition_runs",
];

export function snapshotRowCounts() {
  const db = new Database(`${STATE_DIR}/friday.db`, { readonly: true });
  const out = {};
  for (const t of TABLES) {
    try { out[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; }
    catch { out[t] = null; }
  }
  db.close();
  return out;
}

export async function runPhaseA(ctx) {
  const p = startPhase("A");
  try {
    const health = await api("/v1/health");
    if (health.status !== 200) throw new Error("health!=200");
    const setup = await api("/v1/setup/status", { token: ctx.tokens.accessToken });
    const providers = await api("/v1/providers", { token: ctx.tokens.accessToken });
    const jobs = await api("/v1/jobs", { token: ctx.tokens.accessToken });
    const baseline = snapshotRowCounts();
    p.addEvidence("baseline-row-counts.json", baseline);
    p.addEvidence("health.json", health.body);
    p.addEvidence("setup-status.json", setup.body);
    p.addEvidence("providers.json", providers.body);
    p.addEvidence("jobs.json", jobs.body);
    ctx.baseline = baseline;
    p.note(`baseline rows: memory=${baseline.memory_items} sessions=${baseline.sessions} agent_runs=${baseline.friday_agent_runs}`);
    p.finish("PASS", `boot ok; baseline captured for ${TABLES.length} tables`, []);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"boot phase failed"}]);
    throw e;
  }
}
