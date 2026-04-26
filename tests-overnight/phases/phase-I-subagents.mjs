// Phase I — subagents: spawn via chat, observe table.
import Database from "better-sqlite3";
import { api, isProviderPreconditionFailure, startPhase, sleep, STATE_DIR } from "../lib/util.mjs";
import { ensureAllFixtures } from "../lib/fixtures.mjs";

export async function runPhaseI(ctx) {
  const p = startPhase("I");
  try {
    const before = countRow("friday_subagent_runs");
    const fix = ensureAllFixtures();
    const create = await api("/v1/sessions", {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({ channel: "stab", chatId: `i-${Date.now()}` }),
    });
    const key = create.body?.data?.session?.key;
    await api(`/v1/sessions/${key}/messages`, {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({ role: "user", content: `Spawn a subagent to count the lines in ${fix.csv}. Wait for the subagent to finish, then reply with the line count only.` }),
    });
    const r = await api(`/v1/sessions/${key}/run`, {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({ useLastUserMessage: true }),
    });
    p.addEvidence("run-result.json", r.body);
    const reply = String(r.body?.data?.run?.finalResponse ?? r.body?.data?.run?.response ?? "");
    if (isProviderPreconditionFailure(reply)) {
      p.finish("SKIP", "subagent spawn skipped: no verified text provider/model route available", [
        { severity: "low", note: "subagent prompt could not run because provider precondition failed" },
      ]);
      return;
    }
    await sleep(3000);
    const after = countRow("friday_subagent_runs");
    const list = await api("/v1/agent/subagents", { token: ctx.tokens.accessToken });
    p.addEvidence("subagent-list.json", list.body);
    const anomalies = (after - before) === 0 ? [{severity:"medium", note:"subagent spawn produced 0 new rows"}] : [];
    p.finish("PASS", `subagent rows delta=${after - before}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"subagents threw"}]);
  }
}

function countRow(t) {
  try {
    const db = new Database(`${STATE_DIR}/friday.db`, { readonly: true });
    const out = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    db.close();
    return out;
  } catch { return 0; }
}
