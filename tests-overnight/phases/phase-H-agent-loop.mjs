// Phase H — agent-loop expert mode toggle + observe runs table.
import Database from "better-sqlite3";
import { api, isProviderPreconditionFailure, startPhase, sleep, STATE_DIR } from "../lib/util.mjs";

export async function runPhaseH(ctx) {
  const p = startPhase("H");
  try {
    const before = countRow("friday_agent_loop_runs");
    const en = await api("/v1/agent-loop/expert-mode", {
      method: "PUT", token: ctx.tokens.accessToken,
      body: JSON.stringify({ enabled: true, userIds: ["admin-001"] }),
    });
    p.addEvidence("expert-mode-enable.json", { status: en.status, body: en.body });
    // Trigger run via session chat that should engage agent-loop (failure prompt)
    const chatRes = await runRiskyChat(ctx);
    p.addEvidence("trigger-chat.json", chatRes);
    if (isProviderPreconditionFailure(chatRes.finalResponse)) {
      p.finish("SKIP", "agent-loop trigger skipped: no verified text provider/model route available", [
        { severity: "low", note: "risky chat could not run because provider precondition failed" },
      ]);
      return;
    }
    await sleep(8000);
    const after = countRow("friday_agent_loop_runs");
    const delta = after - before;
    const list = await api("/v1/agent-loop/runs", { token: ctx.tokens.accessToken });
    p.addEvidence("agent-loop-runs.json", list.body);
    const anomalies = delta === 0 ? [{severity:"medium", note: "expert-mode enabled + risky chat: 0 new agent_loop_runs rows"}] : [];
    p.finish("PASS", `agent-loop expert toggled; runs row delta=${delta}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"agent-loop threw"}]);
  }
}

async function runRiskyChat(ctx) {
  const create = await api("/v1/sessions", {
    method: "POST", token: ctx.tokens.accessToken,
    body: JSON.stringify({ channel: "stab", chatId: `h-${Date.now()}` }),
  });
  const key = create.body?.data?.session?.key;
  if (!key) return { error: "no session" };
  await api(`/v1/sessions/${key}/messages`, {
    method: "POST", token: ctx.tokens.accessToken,
    body: JSON.stringify({ role: "user", content: "Diagnose and propose a low-risk fix for: skill 'definitely-not-a-real-skill' is failing repeatedly. Use diagnosis tools and propose an auto-fix." }),
  });
  const r = await api(`/v1/sessions/${key}/run`, {
    method: "POST", token: ctx.tokens.accessToken,
    body: JSON.stringify({ useLastUserMessage: true }),
  });
  return { sessionKey: key, status: r.status, ok: r.body?.ok, finalResponse: r.body?.data?.run?.finalResponse?.slice(0, 200) };
}

function countRow(t) {
  try {
    const db = new Database(`${STATE_DIR}/friday.db`, { readonly: true });
    const out = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    db.close();
    return out;
  } catch { return 0; }
}
