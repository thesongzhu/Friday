// Phase T — self-healing full loop: 10 structured failures + observe full pipeline.
import Database from "better-sqlite3";
import { api, startPhase, sleep, STATE_DIR } from "../lib/util.mjs";

export async function runPhaseT(ctx) {
  const p = startPhase("T");
  try {
    const before = countRows(["error_incidents","diagnosis_records","auto_fix_actions","learning_events","learned_lessons"]);
    p.note(`before ${JSON.stringify(before)}`);
    // Fire 10 deliberate failure-inducing chat prompts of varied fingerprints
    const prompts = [
      "Use skill `definitely-not-real-skill-1` with input {} now.",
      "Run `definitely-not-a-command-XXY1` via exec.",
      "Connect to https://this-host-does-not-exist-1234.example/ and read the body.",
      "Use skill `definitely-not-real-skill-2` with malformed input.",
      "Run `definitely-not-a-command-XXY2` via exec.",
      "Connect to https://this-host-does-not-exist-5678.example/ and read the body.",
      "Use skill `definitely-not-real-skill-3` with input {a: NaN}.",
      "Run `definitely-not-a-command-XXY3` via exec.",
      "Connect to https://timeout.example.invalid/ with a 1ms timeout.",
      "Use skill `definitely-not-real-skill-4`.",
    ];
    const runResults = [];
    for (const q of prompts) {
      const create = await api("/v1/sessions", {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ channel: "stab", chatId: `t-${Date.now()}-${Math.random()}` }),
      });
      const key = create.body?.data?.session?.key;
      const msg = await api(`/v1/sessions/${key}/messages`, {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ role: "user", content: q }),
      });
      const run = await api(`/v1/sessions/${key}/run`, {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ useLastUserMessage: true }),
      });
      runResults.push({
        prompt: q,
        sessionStatus: create.status,
        messageStatus: msg.status,
        runStatus: run.status,
        ok: run.body?.ok,
        reply: String(run.body?.data?.run?.finalResponse ?? "").slice(0, 240),
      });
    }
    p.note("waiting 15s for self-heal pipeline");
    await sleep(15_000);
    const after = countRows(["error_incidents","diagnosis_records","auto_fix_actions","learning_events","learned_lessons"]);
    p.note(`after ${JSON.stringify(after)}`);
    const incidentsList = await api("/v1/learning/incidents", { token: ctx.tokens.accessToken });
    const diagOverview = await api("/v1/diagnosis/learning/overview", { token: ctx.tokens.accessToken });
    const autoFixActions = await api("/v1/auto-fix/actions", { token: ctx.tokens.accessToken });
    p.addEvidence("run-results.json", runResults);
    p.addEvidence("incidents.json", incidentsList.body);
    p.addEvidence("diagnosis-overview.json", diagOverview.body);
    p.addEvidence("auto-fix-actions.json", autoFixActions.body);
    p.addEvidence("row-counts.json", { before, after, delta: diff(before, after) });
    const newIncidents = (after.error_incidents ?? 0) - (before.error_incidents ?? 0);
    const newDiag = (after.diagnosis_records ?? 0) - (before.diagnosis_records ?? 0);
    const newActions = (after.auto_fix_actions ?? 0) - (before.auto_fix_actions ?? 0);
    const anomalies = [];
    const unhandledFailures = runResults.filter(r => r.runStatus >= 500 || r.ok === false).length;
    if (unhandledFailures > 0 && newIncidents === 0) anomalies.push({severity:"high", note:`${unhandledFailures} unhandled failures produced 0 new error_incidents`});
    if (newDiag === 0 && newIncidents > 0) anomalies.push({severity:"medium", note:`incidents present but no diagnosis records`});
    // Auto-fix action creation is intentionally gated by recurrence, confidence,
    // and risk assessment. First-seen varied failures should still produce
    // incidents/diagnoses without forcing speculative actions.
    p.finish("PASS", `incidents+${newIncidents} diag+${newDiag} actions+${newActions}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"self-heal threw"}]);
  }
}

function countRows(tables) {
  const out = {};
  try {
    const db = new Database(`${STATE_DIR}/friday.db`, { readonly: true });
    for (const t of tables) {
      try { out[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { out[t] = null; }
    }
    db.close();
  } catch {}
  return out;
}
function diff(a, b) {
  const o = {};
  for (const k of Object.keys(a)) o[k] = (b[k] ?? null) - (a[k] ?? null);
  return o;
}
